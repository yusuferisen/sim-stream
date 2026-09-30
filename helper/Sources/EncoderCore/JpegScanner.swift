/// Splits a byte stream into whole JPEG images, for `--input mjpeg`.
///
/// The stream is an MJPEG body — WebDriverAgent's `multipart/x-mixed-replace`
/// with its part headers and boundaries between the images — but the scanner
/// never parses those: it looks for an SOI (`FF D8 FF`), walks the marker
/// segments by their lengths up to the start of scan (so an EXIF thumbnail's
/// own SOI/EOI inside APP1 is skipped, not mistaken for the frame's end), then
/// scans the entropy-coded data for the EOI (`FF D9`). Inside entropy data a
/// literal `FF` is always stuffed as `FF 00`, and `FF D0`–`FF D7` are restart
/// markers, so any other marker there is either EOI or (a progressive JPEG)
/// another segment, which is walked the same way. Anything between images is
/// discarded.
///
/// Feed chunks with `push`; each call returns the images that completed.
/// State carries over between calls, so a chunk boundary anywhere — mid
/// marker, mid length field — is fine, and no byte is scanned twice.
public struct JpegScanner {
    /// An image that grows past this is garbage (no real frame comes near it);
    /// the scanner drops it and resynchronises on the next SOI.
    public static let maxFrameBytes = 32 * 1024 * 1024

    private enum Phase { case seekingStart, segments, entropy }

    private var buf: [UInt8] = []
    private var pos = 0
    private var phase = Phase.seekingStart
    public private(set) var droppedFrames = 0

    public init() {}

    public mutating func push(_ bytes: [UInt8]) -> [[UInt8]] {
        buf += bytes
        var frames: [[UInt8]] = []
        scan: while true {
            if phase != .seekingStart && pos > Self.maxFrameBytes {
                resync()
            }
            switch phase {
            case .seekingStart:
                // SOI is FF D8, and the first segment's marker follows at once.
                var found: Int?
                var i = pos
                while i + 2 < buf.count {
                    if buf[i] == 0xFF && buf[i + 1] == 0xD8 && buf[i + 2] == 0xFF { found = i; break }
                    i += 1
                }
                guard let start = found else {
                    // Keep the last two bytes: they may be the start of an SOI.
                    let keep = min(buf.count, 2)
                    buf.removeFirst(buf.count - keep)
                    pos = 0
                    break scan
                }
                buf.removeFirst(start)
                pos = 2
                phase = .segments

            case .segments:
                guard pos + 1 < buf.count else { break scan }
                guard buf[pos] == 0xFF else { resync(); continue scan }
                let marker = buf[pos + 1]
                switch marker {
                case 0xFF:
                    pos += 1 // fill byte before a marker
                case 0xD9:
                    frames.append(take(upTo: pos + 2)) // EOI with no scan: a (broken) image all the same
                case 0xD8:
                    buf.removeFirst(pos) // a new SOI: the previous image was cut short
                    droppedFrames += 1
                    pos = 2
                case 0x01, 0xD0...0xD7:
                    pos += 2 // standalone markers carry no length
                default:
                    guard pos + 3 < buf.count else { break scan }
                    let length = Int(buf[pos + 2]) << 8 | Int(buf[pos + 3])
                    guard length >= 2 else { resync(); continue scan }
                    pos += 2 + length
                    if marker == 0xDA { phase = .entropy } // SOS: entropy data follows its header
                }

            case .entropy:
                var i = pos
                var next: UInt8?
                while i + 1 < buf.count {
                    if buf[i] == 0xFF {
                        let m = buf[i + 1]
                        if m == 0x00 || (0xD0...0xD7).contains(m) { i += 2; continue }
                        if m == 0xFF { i += 1; continue }
                        next = m
                        break
                    }
                    i += 1
                }
                pos = i
                guard let m = next else { break scan }
                if m == 0xD9 {
                    frames.append(take(upTo: pos + 2))
                } else {
                    phase = .segments // another segment (progressive JPEG), walked by length
                }
            }
        }
        return frames
    }

    /// Removes and returns bytes `0..<end` (the current image, starting at 0).
    private mutating func take(upTo end: Int) -> [UInt8] {
        let frame = Array(buf[0..<end])
        buf.removeFirst(end)
        pos = 0
        phase = .seekingStart
        return frame
    }

    /// The current image is malformed: drop it and look for the next SOI.
    /// Everything before `pos` was walked as this image's segments, so no
    /// image starts there — skipping it is what keeps an EXIF thumbnail's SOI
    /// from being taken for the next frame.
    private mutating func resync() {
        droppedFrames += 1
        buf.removeFirst(min(max(pos, 1), buf.count))
        pos = 0
        phase = .seekingStart
    }
}

/// The pixel size of a JPEG, read from its SOF header.
public enum JpegInfo {
    /// `(width, height)` from the first SOF segment, or nil when `bytes` is
    /// not a JPEG, is cut short before its SOF, or declares a zero size.
    public static func size(of bytes: [UInt8]) -> (width: Int, height: Int)? {
        guard bytes.count >= 4, bytes[0] == 0xFF, bytes[1] == 0xD8 else { return nil }
        var i = 2
        while i + 3 < bytes.count {
            guard bytes[i] == 0xFF else { return nil }
            let marker = bytes[i + 1]
            if marker == 0xFF { i += 1; continue }
            if marker == 0x01 || (0xD0...0xD7).contains(marker) { i += 2; continue }
            if marker == 0xD9 || marker == 0xDA { return nil } // no SOF before the scan
            let length = Int(bytes[i + 2]) << 8 | Int(bytes[i + 3])
            guard length >= 2 else { return nil }
            // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
            if (0xC0...0xCF).contains(marker) && ![0xC4, 0xC8, 0xCC].contains(marker) {
                guard i + 8 < bytes.count else { return nil }
                let h = Int(bytes[i + 5]) << 8 | Int(bytes[i + 6])
                let w = Int(bytes[i + 7]) << 8 | Int(bytes[i + 8])
                return w > 0 && h > 0 ? (w, h) : nil
            }
            i += 2 + length
        }
        return nil
    }
}

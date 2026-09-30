// sim-stream-encoder — raw BGRA frames (or an MJPEG body) on stdin → hardware
// H.264 on stdout.
//
//   axe stream-video --udid <UDID> --format bgra --fps 30 --scale 0.5 \
//     | sim-stream-encoder --source 1206x2622 --scale 0.5 --output annexb > out.h264
//   curl -sN http://127.0.0.1:<forwarded WDA MJPEG port>/ \
//     | sim-stream-encoder --input mjpeg --output annexb > out.h264
//
// Contract (arguments, input layout, output framing, exit codes):
// docs/architecture.md § H.264 encoder helper. Diagnostics go to stderr only.

import CoreGraphics
import CoreMedia
import CoreVideo
import Darwin
import EncoderCore
import Foundation
import ImageIO
import VideoToolbox

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("sim-stream-encoder: \(message)\n".utf8))
    exit(code)
}

let options: Options
do {
    options = try Options.parse(Array(CommandLine.arguments.dropFirst()))
} catch {
    fail("\(error)\n\(Options.usage)", code: 2)
}

// Only the BGRA input has a byte layout; JPEG images carry their own size.
let layout = FrameLayout.axe(sourceWidth: options.sourceWidth,
                             sourceHeight: options.sourceHeight,
                             scale: options.scale)

// A closed stdout (the server dropped us) must end the process quietly, not kill it with SIGPIPE.
signal(SIGPIPE, SIG_IGN)

// MARK: - Output

/// Writes all bytes to stdout; exits 0 when the reader is gone.
func writeAll(_ bytes: [UInt8]) {
    bytes.withUnsafeBytes { raw in
        var off = 0
        while off < raw.count {
            let n = write(STDOUT_FILENO, raw.baseAddress! + off, raw.count - off)
            if n < 0 {
                if errno == EINTR { continue }
                exit(0) // EPIPE: nobody is listening any more
            }
            off += n
        }
    }
}

// MARK: - Encoder session

/// VideoToolbox output callback. Runs on VT's own queue, serially and in
/// decode order (frame reordering is off, so decode order == display order).
let outputCallback: VTCompressionOutputCallback = { _, _, status, _, sampleBuffer in
    guard status == noErr, let sb = sampleBuffer, CMSampleBufferDataIsReady(sb) else {
        FileHandle.standardError.write(Data("sim-stream-encoder: encode failed (\(status))\n".utf8))
        return
    }

    var keyframe = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
       let first = attachments.first,
       let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
        keyframe = !notSync
    }

    // Parameter sets travel with every keyframe so a stream can be joined at any one.
    var parameterSets: [[UInt8]] = []
    var nalLengthSize: Int32 = 4
    if let format = CMSampleBufferGetFormatDescription(sb) {
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLengthSize)
        if keyframe {
            for idx in 0..<count {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format, parameterSetIndex: idx, parameterSetPointerOut: &ptr,
                    parameterSetSizeOut: &size, parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil) == noErr, let ptr {
                    parameterSets.append(Array(UnsafeBufferPointer(start: ptr, count: size)))
                }
            }
        }
    }

    guard let block = CMSampleBufferGetDataBuffer(sb) else { return }
    let length = CMBlockBufferGetDataLength(block)
    var avcc = [UInt8](repeating: 0, count: length)
    guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length,
                                     destination: &avcc) == kCMBlockBufferNoErr,
          let au = Framing.annexB(avcc: avcc, nalLengthSize: Int(nalLengthSize),
                                  parameterSets: parameterSets) else {
        FileHandle.standardError.write(Data("sim-stream-encoder: malformed encoder output, frame dropped\n".utf8))
        return
    }

    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    let micros = UInt64(max(0, CMTimeConvertScale(pts, timescale: 1_000_000, method: .default).value))

    if options.output == .framed {
        writeAll(Framing.header(payloadLength: au.count, keyframe: keyframe, ptsMicros: micros) + au)
    } else {
        writeAll(au)
    }
}

func makeSession(width: Int, height: Int, bitrate: Int, lowLatency: Bool) -> VTCompressionSession? {
    var spec: [CFString: Any] = [
        kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
    ]
    if lowLatency { spec[kVTVideoEncoderSpecification_EnableLowLatencyRateControl] = true }
    let sourceAttrs: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
    ]
    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(
        allocator: nil, width: Int32(width), height: Int32(height),
        codecType: kCMVideoCodecType_H264, encoderSpecification: spec as CFDictionary,
        imageBufferAttributes: sourceAttrs as CFDictionary, compressedDataAllocator: nil,
        outputCallback: outputCallback, refcon: nil, compressionSessionOut: &session)
    guard status == noErr, let session else { return nil }

    let props: [CFString: Any] = [
        kVTCompressionPropertyKey_RealTime: true,
        kVTCompressionPropertyKey_AllowFrameReordering: false, // no B-frames
        kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_Main_AutoLevel,
        kVTCompressionPropertyKey_ExpectedFrameRate: options.fps,
        kVTCompressionPropertyKey_MaxKeyFrameInterval: options.fps,     // a keyframe every second…
        kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 1.0,     // …even when frames arrive slowly
        kVTCompressionPropertyKey_AverageBitRate: bitrate,
    ]
    for (key, value) in props {
        let s = VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
        if s != noErr {
            FileHandle.standardError.write(Data("sim-stream-encoder: property \(key) rejected (\(s))\n".utf8))
        }
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
    return session
}

/// A started encoder: the session, its pixel buffer pool and the picture size.
struct Encoder {
    let session: VTCompressionSession
    let pool: CVPixelBufferPool
    let width: Int
    let height: Int
}

/// Creates the session for a `width`×`height` picture (both even) and says so on stderr.
func startEncoder(width: Int, height: Int, inputNote: String) -> Encoder {
    let bitrate = options.bitrate ?? Options.defaultBitrate(width: width, height: height, fps: options.fps)
    guard let session = makeSession(width: width, height: height, bitrate: bitrate, lowLatency: true)
            ?? makeSession(width: width, height: height, bitrate: bitrate, lowLatency: false) else {
        fail("could not create a VideoToolbox H.264 session for \(width)x\(height)")
    }
    guard let pool = VTCompressionSessionGetPixelBufferPool(session) else {
        fail("VideoToolbox gave no pixel buffer pool")
    }
    FileHandle.standardError.write(Data((
        "sim-stream-encoder: \(width)x\(height) @\(options.fps)fps " +
        "\(bitrate / 1000) kbit/s, input \(inputNote), output \(options.output.rawValue)\n").utf8))
    return Encoder(session: session, pool: pool, width: width, height: height)
}

// Presentation time = arrival time, so a stalled capture shows as a stall, not a speed-up.
var clockStart: UInt64?
func arrivalTime() -> CMTime {
    let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    if clockStart == nil { clockStart = now }
    return CMTime(value: CMTimeValue((now - clockStart!) / 1_000), timescale: 1_000_000)
}

/// A pixel buffer from the pool, filled by `fill(base, bytesPerRow)` while locked.
func pixelBuffer(_ enc: Encoder, fill: (UnsafeMutableRawPointer, Int) -> Void) -> CVPixelBuffer {
    var pixelBuffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, enc.pool, &pixelBuffer) == kCVReturnSuccess,
          let pb = pixelBuffer else {
        fail("could not allocate a pixel buffer")
    }
    CVPixelBufferLockBaseAddress(pb, [])
    fill(CVPixelBufferGetBaseAddress(pb)!, CVPixelBufferGetBytesPerRow(pb))
    CVPixelBufferUnlockBaseAddress(pb, [])
    return pb
}

func encode(_ enc: Encoder, _ pb: CVPixelBuffer, at pts: CMTime) {
    let s = VTCompressionSessionEncodeFrame(
        enc.session, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
        frameProperties: nil, sourceFrameRefcon: nil, infoFlagsOut: nil)
    if s != noErr { fail("encode failed (\(s))") }
}

func finish(_ enc: Encoder?) -> Never {
    if let enc {
        VTCompressionSessionCompleteFrames(enc.session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(enc.session)
    }
    exit(0)
}

// MARK: - Input loop

/// Fills `buf` completely from stdin. Returns the number of bytes read, which
/// is less than `buf.count` only at end of input.
func readFull(into buf: UnsafeMutableRawBufferPointer) -> Int {
    var got = 0
    while got < buf.count {
        let n = read(STDIN_FILENO, buf.baseAddress! + got, buf.count - got)
        if n == 0 { break }
        if n < 0 {
            if errno == EINTR { continue }
            fail("stdin read failed: \(String(cString: strerror(errno)))")
        }
        got += n
    }
    return got
}

/// `axe stream-video --format bgra`: fixed-size frames, padding copied away.
func runBGRA() -> Never {
    let enc = startEncoder(
        width: layout.encodedWidth, height: layout.encodedHeight,
        inputNote: "\(layout.bytesPerRow)B/row x \(layout.rows) rows (\(layout.frameBytes) B/frame)")
    let frame = UnsafeMutableRawBufferPointer.allocate(byteCount: layout.frameBytes, alignment: 64)
    let rowCopyBytes = layout.encodedWidth * 4
    while true {
        let got = readFull(into: frame)
        if got < layout.frameBytes {
            if got > 0 {
                FileHandle.standardError.write(Data("sim-stream-encoder: dropped a trailing partial frame (\(got) of \(layout.frameBytes) bytes)\n".utf8))
            }
            finish(enc)
        }
        let pts = arrivalTime()
        let pb = pixelBuffer(enc) { dst, dstStride in
            for row in 0..<layout.encodedHeight { // padding (and an odd last row/column) never reaches the encoder
                memcpy(dst + row * dstStride, frame.baseAddress! + row * layout.bytesPerRow, rowCopyBytes)
            }
        }
        encode(enc, pb, at: pts)
    }
}

/// An MJPEG body: whole JPEGs found by `JpegScanner`, decoded by ImageIO,
/// drawn into the encoder's buffer. The picture size is `--source` (made
/// even), else the first image's. An image of another size (a rotation) is
/// scaled to fill it rather than stopping the stream; one of the same size is
/// drawn 1:1, losing only an odd last column/row.
func runMJPEG() -> Never {
    var enc: Encoder?
    if options.sourceWidth > 0 {
        enc = startEncoder(width: options.sourceWidth & ~1, height: options.sourceHeight & ~1,
                           inputNote: "mjpeg \(options.sourceWidth)x\(options.sourceHeight)")
    }
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let bitmapInfo = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    var scanner = JpegScanner()
    var undecodable = 0
    let chunk = UnsafeMutableRawBufferPointer.allocate(byteCount: 256 * 1024, alignment: 16)
    while true {
        let n = read(STDIN_FILENO, chunk.baseAddress!, chunk.count)
        if n == 0 { finish(enc) }
        if n < 0 {
            if errno == EINTR { continue }
            fail("stdin read failed: \(String(cString: strerror(errno)))")
        }
        for jpeg in scanner.push(Array(UnsafeRawBufferPointer(rebasing: chunk[0..<n]))) {
            let pts = arrivalTime()
            guard let src = CGImageSourceCreateWithData(Data(jpeg) as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
                undecodable += 1
                if undecodable == 1 || undecodable % 100 == 0 {
                    FileHandle.standardError.write(Data("sim-stream-encoder: \(undecodable) undecodable image(s) skipped\n".utf8))
                }
                continue
            }
            if enc == nil {
                let (w, h) = JpegInfo.size(of: jpeg) ?? (image.width, image.height)
                guard w >= 2 && h >= 2 else { fail("first image is too small (\(w)x\(h))") }
                enc = startEncoder(width: w & ~1, height: h & ~1, inputNote: "mjpeg \(w)x\(h) (first image)")
            }
            let e = enc!
            let pb = pixelBuffer(e) { base, bytesPerRow in
                guard let ctx = CGContext(data: base, width: e.width, height: e.height, bitsPerComponent: 8,
                                          bytesPerRow: bytesPerRow, space: colorSpace, bitmapInfo: bitmapInfo) else {
                    fail("could not draw into a pixel buffer")
                }
                // CoreGraphics' origin is bottom-left: a same-size image is
                // placed so its top-left corner is the buffer's.
                let sameSize = image.width & ~1 == e.width && image.height & ~1 == e.height
                let rect = sameSize
                    ? CGRect(x: 0, y: e.height - image.height, width: image.width, height: image.height)
                    : CGRect(x: 0, y: 0, width: e.width, height: e.height)
                ctx.draw(image, in: rect)
            }
            encode(e, pb, at: pts)
        }
    }
}

switch options.input {
case .bgra: runBGRA()
case .mjpeg: runMJPEG()
}

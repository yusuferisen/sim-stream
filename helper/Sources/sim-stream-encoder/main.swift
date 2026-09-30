// sim-stream-encoder — raw BGRA frames on stdin → hardware H.264 on stdout.
//
//   axe stream-video --udid <UDID> --format bgra --fps 30 --scale 0.5 \
//     | sim-stream-encoder --source 1206x2622 --scale 0.5 --output annexb > out.h264
//
// Contract (arguments, input layout, output framing, exit codes):
// docs/architecture.md § H.264 encoder helper. Diagnostics go to stderr only.

import CoreMedia
import CoreVideo
import Darwin
import EncoderCore
import Foundation
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

let layout = FrameLayout.axe(sourceWidth: options.sourceWidth,
                             sourceHeight: options.sourceHeight,
                             scale: options.scale)
let bitrate = options.bitrate
    ?? Options.defaultBitrate(width: layout.encodedWidth, height: layout.encodedHeight, fps: options.fps)

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

func makeSession(lowLatency: Bool) -> VTCompressionSession? {
    var spec: [CFString: Any] = [
        kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
    ]
    if lowLatency { spec[kVTVideoEncoderSpecification_EnableLowLatencyRateControl] = true }
    let sourceAttrs: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey: layout.encodedWidth,
        kCVPixelBufferHeightKey: layout.encodedHeight,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
    ]
    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(
        allocator: nil, width: Int32(layout.encodedWidth), height: Int32(layout.encodedHeight),
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

guard let session = makeSession(lowLatency: true) ?? makeSession(lowLatency: false) else {
    fail("could not create a VideoToolbox H.264 session for \(layout.encodedWidth)x\(layout.encodedHeight)")
}
guard let pool = VTCompressionSessionGetPixelBufferPool(session) else {
    fail("VideoToolbox gave no pixel buffer pool")
}

FileHandle.standardError.write(Data((
    "sim-stream-encoder: \(layout.encodedWidth)x\(layout.encodedHeight) @\(options.fps)fps " +
    "\(bitrate / 1000) kbit/s, input \(layout.bytesPerRow)B/row x \(layout.rows) rows " +
    "(\(layout.frameBytes) B/frame), output \(options.output.rawValue)\n").utf8))

// MARK: - Input loop

/// Fills `buf` completely from stdin. Returns the number of bytes read, which
/// is less than `buf.count` only at end of input.
func readFrame(into buf: UnsafeMutableRawBufferPointer) -> Int {
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

let frame = UnsafeMutableRawBufferPointer.allocate(byteCount: layout.frameBytes, alignment: 64)
var clockStart: UInt64?
let rowCopyBytes = layout.encodedWidth * 4

while true {
    let got = readFrame(into: frame)
    if got < layout.frameBytes {
        if got > 0 {
            FileHandle.standardError.write(Data("sim-stream-encoder: dropped a trailing partial frame (\(got) of \(layout.frameBytes) bytes)\n".utf8))
        }
        break
    }

    // Presentation time = arrival time, so a stalled capture shows as a stall, not a speed-up.
    let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    if clockStart == nil { clockStart = now }
    let pts = CMTime(value: CMTimeValue((now - clockStart!) / 1_000), timescale: 1_000_000)

    var pixelBuffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer) == kCVReturnSuccess,
          let pb = pixelBuffer else {
        fail("could not allocate a pixel buffer")
    }
    CVPixelBufferLockBaseAddress(pb, [])
    let dst = CVPixelBufferGetBaseAddress(pb)!
    let dstStride = CVPixelBufferGetBytesPerRow(pb)
    for row in 0..<layout.encodedHeight { // padding (and an odd last row/column) never reaches the encoder
        memcpy(dst + row * dstStride, frame.baseAddress! + row * layout.bytesPerRow, rowCopyBytes)
    }
    CVPixelBufferUnlockBaseAddress(pb, [])

    let s = VTCompressionSessionEncodeFrame(
        session, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
        frameProperties: nil, sourceFrameRefcon: nil, infoFlagsOut: nil)
    if s != noErr { fail("encode failed (\(s))") }
}

VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
VTCompressionSessionInvalidate(session)
exit(0)

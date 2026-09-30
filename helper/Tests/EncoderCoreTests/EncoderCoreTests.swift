import EncoderCore
import Testing

@Suite("Options.parse")
struct OptionsTests {
    @Test func defaults() throws {
        let o = try Options.parse(["--source", "1206x2622"])
        #expect(o == Options(sourceWidth: 1206, sourceHeight: 2622))
        #expect(o.scale == 1.0 && o.fps == 30 && o.bitrate == nil && o.output == .framed)
    }

    @Test func allFlags() throws {
        let o = try Options.parse(["--source", "603x1311", "--scale", "0.5", "--fps", "15",
                                   "--bitrate", "2000000", "--output", "annexb"])
        #expect(o == Options(sourceWidth: 603, sourceHeight: 1311, scale: 0.5, fps: 15,
                             bitrate: 2_000_000, output: .annexb))
    }

    @Test(arguments: [
        ([], "--source is required"),
        (["--source"], "--source requires a value"),
        (["--source", "--scale", "0.5"], "--source requires a value"),
        (["--source", "1206"], "--source must be <width>x<height> in pixels, got 1206"),
        (["--source", "1206x"], "--source must be <width>x<height> in pixels, got 1206x"),
        (["--source", "0x100"], "--source must be <width>x<height> in pixels, got 0x100"),
        (["--source", "10x10", "--scale", "0"], "--scale must be between 0.1 and 1.0, got 0"),
        (["--source", "10x10", "--scale", "1.5"], "--scale must be between 0.1 and 1.0, got 1.5"),
        (["--source", "10x10", "--fps", "31"], "--fps must be an integer 1-30, got 31"),
        (["--source", "10x10", "--fps", "2.5"], "--fps must be an integer 1-30, got 2.5"),
        (["--source", "10x10", "--bitrate", "10"], "--bitrate must be an integer ≥ 50000 (bits/s), got 10"),
        (["--source", "10x10", "--output", "mp4"], "--output must be framed or annexb, got mp4"),
        (["--source", "10x10", "--verbose"], "unknown argument --verbose"),
    ] as [([String], String)])
    func rejects(args: [String], message: String) {
        #expect(throws: OptionsError(message)) { try Options.parse(args) }
    }

    @Test func defaultBitrate() {
        #expect(Options.defaultBitrate(width: 603, height: 1311, fps: 30) == 1_897_279)
        #expect(Options.defaultBitrate(width: 10, height: 10, fps: 1) == 250_000)
    }
}

@Suite("FrameLayout.axe — measured against AXe 1.8.0")
struct FrameLayoutTests {
    // (scale, picture w, picture h, bytes/row, rows, measured frame bytes)
    @Test(arguments: [
        (1.0, 1206, 2622, 4864, 2624, 12_763_136),
        (0.99, 1193, 2595, 4800, 2595, 12_456_000),
        (0.9, 1085, 2359, 4352, 2359, 10_266_368),
        (0.5, 603, 1311, 2432, 1311, 3_188_352),
        (0.33, 397, 865, 1600, 865, 1_384_000),
        (0.25, 301, 655, 1216, 655, 796_480),
    ] as [(Double, Int, Int, Int, Int, Int)])
    func iPhoneSource(scale: Double, w: Int, h: Int, rowBytes: Int, rows: Int, frameBytes: Int) {
        let l = FrameLayout.axe(sourceWidth: 1206, sourceHeight: 2622, scale: scale)
        #expect(l == FrameLayout(width: w, height: h, bytesPerRow: rowBytes, rows: rows))
        #expect(l.frameBytes == frameBytes)
        #expect(l.encodedWidth == w & ~1 && l.encodedHeight == h & ~1)
    }

    @Test func oddPictureEncodesEven() {
        let l = FrameLayout.axe(sourceWidth: 1206, sourceHeight: 2622, scale: 0.5)
        #expect((l.encodedWidth, l.encodedHeight) == (602, 1310))
        let full = FrameLayout.axe(sourceWidth: 1206, sourceHeight: 2622, scale: 1.0)
        #expect((full.encodedWidth, full.encodedHeight) == (1206, 2622))
    }
}

@Suite("Framing")
struct FramingTests {
    @Test func headerLayout() {
        let h = Framing.header(payloadLength: 0x0102_0304, keyframe: true, ptsMicros: 0x1122_3344_5566_7788)
        #expect(h == [0x01, 0x02, 0x03, 0x04, 0x01, 0, 0, 0,
                      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88])
        #expect(Framing.header(payloadLength: 5, keyframe: false, ptsMicros: 33_333)[4] == 0)
    }

    @Test func avccToAnnexBWithParameterSets() {
        let avcc: [UInt8] = [0, 0, 0, 2, 0x65, 0xAA, 0, 0, 0, 1, 0x06]
        let out = Framing.annexB(avcc: avcc, parameterSets: [[0x67, 0x4D], [0x68]])
        #expect(out == [0, 0, 0, 1, 0x67, 0x4D, 0, 0, 0, 1, 0x68,
                        0, 0, 0, 1, 0x65, 0xAA, 0, 0, 0, 1, 0x06])
    }

    @Test func shortLengthPrefix() {
        #expect(Framing.annexB(avcc: [0, 1, 0x41], nalLengthSize: 2) == [0, 0, 0, 1, 0x41])
    }

    @Test(arguments: [
        [0, 0, 0, 5, 0x65],     // length runs past the buffer
        [0, 0, 0],              // truncated length prefix
        [0, 0, 0, 0],           // zero-length NAL
    ] as [[UInt8]])
    func malformedIsNil(avcc: [UInt8]) {
        #expect(Framing.annexB(avcc: avcc) == nil)
    }

    @Test func emptyInputIsEmpty() {
        #expect(Framing.annexB(avcc: []) == [])
    }
}

@Suite("Options.parse --input mjpeg")
struct MjpegOptionsTests {
    @Test func sourceIsOptional() throws {
        let o = try Options.parse(["--input", "mjpeg"])
        #expect(o == Options(sourceWidth: 0, sourceHeight: 0, input: .mjpeg))
        let sized = try Options.parse(["--input", "mjpeg", "--source", "585x1266", "--fps", "30"])
        #expect(sized == Options(sourceWidth: 585, sourceHeight: 1266, fps: 30, input: .mjpeg))
    }

    @Test func bgraIsTheDefaultAndStillNeedsSource() throws {
        #expect(try Options.parse(["--input", "bgra", "--source", "10x10"]).input == .bgra)
        #expect(throws: OptionsError("--source is required")) { try Options.parse(["--input", "bgra"]) }
    }

    @Test(arguments: [
        (["--input", "mjpeg", "--scale", "0.5"], "--scale does not apply to --input mjpeg (the images arrive scaled)"),
        (["--input", "png"], "--input must be bgra or mjpeg, got png"),
        (["--input"], "--input requires a value"),
    ] as [([String], String)])
    func rejects(args: [String], message: String) {
        #expect(throws: OptionsError(message)) { try Options.parse(args) }
    }
}

/// A marker-valid (not decodable) JPEG: an APP1 carrying a thumbnail with its
/// own SOI/EOI, an SOF0 of `width`×`height`, an SOS, and entropy data holding
/// a stuffed FF 00 and a restart marker — every trap an SOI/EOI scan falls into.
func fakeJpeg(width: Int = 585, height: Int = 1266, fill: UInt8 = 0x11) -> [UInt8] {
    let thumb: [UInt8] = [0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x03, 0x00, 0xFF, 0xD9]
    let app1: [UInt8] = [0xFF, 0xE1] + [0x00, UInt8(2 + 6 + thumb.count)] + Array("Exif\0\0".utf8) + thumb
    let sof: [UInt8] = [0xFF, 0xC0, 0x00, 0x11, 0x08,
                        UInt8(height >> 8), UInt8(height & 0xFF), UInt8(width >> 8), UInt8(width & 0xFF),
                        0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]
    let sos: [UInt8] = [0xFF, 0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00]
    let entropy: [UInt8] = [fill, 0xFF, 0x00, fill, 0xFF, 0xD3, fill, 0xFF, 0xFF, 0x00, fill]
    return [0xFF, 0xD8] + app1 + sof + sos + entropy + [0xFF, 0xD9]
}

/// WDA's multipart framing around each image.
func part(_ jpeg: [UInt8]) -> [UInt8] {
    Array("--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n".utf8)
        + jpeg + Array("\r\n\r\n".utf8)
}

@Suite("JpegScanner")
struct JpegScannerTests {
    @Test func findsWholeImagesInAMultipartBody() {
        let a = fakeJpeg(fill: 0x11), b = fakeJpeg(fill: 0x22)
        var s = JpegScanner()
        #expect(s.push(part(a) + part(b)) == [a, b])
        #expect(s.droppedFrames == 0)
    }

    /// Every split point, so a boundary mid-marker or mid-length is covered.
    @Test func anyChunkBoundary() {
        let a = fakeJpeg(fill: 0x11), b = fakeJpeg(fill: 0x22)
        let body = part(a) + part(b)
        for cut in 0...body.count {
            var s = JpegScanner()
            let got = s.push(Array(body[0..<cut])) + s.push(Array(body[cut...]))
            #expect(got == [a, b], "cut at \(cut)")
        }
    }

    @Test func byteAtATime() {
        let a = fakeJpeg()
        var s = JpegScanner()
        var got: [[UInt8]] = []
        for byte in part(a) + part(a) { got += s.push([byte]) }
        #expect(got == [a, a])
    }

    @Test func aCutShortImageIsDroppedForTheNextOne() {
        let a = fakeJpeg(fill: 0x11), b = fakeJpeg(fill: 0x22)
        var s = JpegScanner()
        // Cut inside the SOF segment: the next SOI arrives where a marker should.
        let truncated = Array(a[0..<40])
        #expect(s.push(truncated + part(b)) == [b])
        #expect(s.droppedFrames == 1)
    }

    @Test func garbageOnlyYieldsNothing() {
        var s = JpegScanner()
        #expect(s.push(Array(repeating: 0xFF, count: 1000)).isEmpty)
        // …but the trailing FF is kept: it may be the first byte of an SOI.
        let a = fakeJpeg()
        #expect(s.push(Array(a[1...])) == [a])
    }

    @Test func oversizedImageIsDropped() {
        var s = JpegScanner()
        // A valid start (SOI … SOS), then entropy data that never ends.
        let jpeg = fakeJpeg()
        let sos = Array(jpeg[..<jpeg.firstIndex(of: 0xDA)!]) + [0xDA, 0x00, 0x02]
        #expect(s.push(sos + Array(repeating: 0x11, count: JpegScanner.maxFrameBytes)).isEmpty)
        let b = fakeJpeg(fill: 0x22)
        #expect(s.push(part(b)) == [b])
        #expect(s.droppedFrames == 1)
    }
}

@Suite("JpegInfo.size")
struct JpegInfoTests {
    @Test func readsTheSOFPastAnApp1Thumbnail() {
        #expect(JpegInfo.size(of: fakeJpeg(width: 585, height: 1266))! == (585, 1266))
        #expect(JpegInfo.size(of: fakeJpeg(width: 1170, height: 2532))! == (1170, 2532))
    }

    @Test func truncatedOrNotJpegIsNil() {
        let a = fakeJpeg()
        #expect(JpegInfo.size(of: Array(a[0..<25])) == nil)
        #expect(JpegInfo.size(of: [0x89, 0x50, 0x4E, 0x47]) == nil)
        #expect(JpegInfo.size(of: fakeJpeg(width: 0, height: 10)) == nil)
    }
}

/// Output framing for `--output framed`: one record per encoded frame,
///
///     offset 0  u32 BE  payload length in bytes
///     offset 4  u8      flags — bit 0 set: keyframe (IDR, preceded by SPS + PPS)
///     offset 5  3 bytes reserved, zero
///     offset 8  u64 BE  presentation timestamp, microseconds since the first frame
///     offset 16 payload — one H.264 access unit, Annex B (00 00 00 01 start codes)
public enum Framing {
    public static let headerSize = 16
    public static let keyframeFlag: UInt8 = 0x01
    public static let startCode: [UInt8] = [0, 0, 0, 1]

    public static func header(payloadLength: Int, keyframe: Bool, ptsMicros: UInt64) -> [UInt8] {
        var h = [UInt8](repeating: 0, count: headerSize)
        let len = UInt32(payloadLength)
        for k in 0..<4 { h[k] = UInt8(truncatingIfNeeded: len >> (24 - 8 * UInt32(k))) }
        h[4] = keyframe ? keyframeFlag : 0
        for k in 0..<8 { h[8 + k] = UInt8(truncatingIfNeeded: ptsMicros >> (56 - 8 * UInt64(k))) }
        return h
    }

    /// Converts length-prefixed NAL units (AVCC, as VideoToolbox emits them)
    /// to Annex B, prepending `parameterSets` (SPS, PPS — raw NAL bytes) each
    /// behind its own start code. Returns nil on a malformed buffer.
    public static func annexB(avcc: [UInt8], nalLengthSize: Int = 4,
                              parameterSets: [[UInt8]] = []) -> [UInt8]? {
        guard (1...4).contains(nalLengthSize) else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(avcc.count + parameterSets.reduce(0) { $0 + $1.count + 4 } + 16)
        for ps in parameterSets {
            out += startCode
            out += ps
        }
        var i = 0
        while i < avcc.count {
            guard i + nalLengthSize <= avcc.count else { return nil }
            var n = 0
            for k in 0..<nalLengthSize { n = (n << 8) | Int(avcc[i + k]) }
            i += nalLengthSize
            guard n > 0, i + n <= avcc.count else { return nil }
            out += startCode
            out += avcc[i..<(i + n)]
            i += n
        }
        return out
    }
}

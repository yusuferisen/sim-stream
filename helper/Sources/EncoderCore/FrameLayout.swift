/// The byte layout of one frame from `axe stream-video --format bgra`.
///
/// AXe writes frames back to back with no header, as raw CVPixelBuffer memory
/// — so rows carry alignment padding and the frame size is not `w*h*4`.
/// Measured on AXe 1.8.0 (iPhone, 1206×2622 pixels):
///
/// | `--scale` | picture    | bytes/row | rows | frame bytes |
/// |-----------|------------|-----------|------|-------------|
/// | 1.0       | 1206×2622  | 4864      | 2624 | 12 763 136  |
/// | 0.99      | 1193×2595  | 4800      | 2595 | 12 456 000  |
/// | 0.9       | 1085×2359  | 4352      | 2359 | 10 266 368  |
/// | 0.5       | 603×1311   | 2432      | 1311 |  3 188 352  |
/// | 0.25      | 301×655    | 1216      | 655  |    796 480  |
///
/// Rules: a scaled picture is `floor(pixels × scale)` on each axis; rows are
/// padded to 64 bytes; at scale 1.0 (no resampling, the capture surface itself)
/// the row count is additionally padded to a multiple of 16. Padding is black
/// (all-zero) and never part of the picture.
///
/// H.264 4:2:0 can only code even dimensions (its crop unit is 2 pixels), so
/// the **encoded** picture drops an odd last column and/or row:
/// 603×1311 → 602×1310. That is under one source pixel at the right/bottom
/// edge; a viewer that maps the decoded picture onto the full device bounds
/// stretches it by under one pixel — no correction needed.
public struct FrameLayout: Equatable {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    public let rows: Int

    public var frameBytes: Int { bytesPerRow * rows }
    public var encodedWidth: Int { width & ~1 }
    public var encodedHeight: Int { height & ~1 }

    public init(width: Int, height: Int, bytesPerRow: Int, rows: Int) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.rows = rows
    }

    public static func axe(sourceWidth: Int, sourceHeight: Int, scale: Double) -> FrameLayout {
        let unscaled = scale >= 1.0
        let w = unscaled ? sourceWidth : Int((Double(sourceWidth) * scale).rounded(.down))
        let h = unscaled ? sourceHeight : Int((Double(sourceHeight) * scale).rounded(.down))
        return FrameLayout(
            width: w,
            height: h,
            bytesPerRow: align(w * 4, to: 64),
            rows: unscaled ? align(h, to: 16) : h
        )
    }

    static func align(_ n: Int, to a: Int) -> Int { (n + a - 1) / a * a }
}

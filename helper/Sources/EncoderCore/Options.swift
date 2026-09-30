/// Command-line options for `sim-stream-encoder`.
///
///     sim-stream-encoder --source <W>x<H> [--scale <S>] [--fps <N>]
///                        [--bitrate <bps>] [--output framed|annexb]
///
/// `--source` is the simulator's screen size in **pixels** (a screenshot's PNG
/// size), `--scale` the same value passed to `axe stream-video --scale`. The
/// helper derives AXe's raw frame layout from those two (see `FrameLayout`).
public struct Options: Equatable {
    public enum Output: String, Equatable {
        /// 16-byte header + Annex-B access unit per frame (what sim-stream reads).
        case framed
        /// Bare Annex-B elementary stream (what `ffprobe`/`ffplay` read).
        case annexb
    }

    public var sourceWidth: Int
    public var sourceHeight: Int
    public var scale: Double = 1.0
    public var fps: Int = 30
    /// nil → derived from the picture size (see `defaultBitrate`).
    public var bitrate: Int? = nil
    public var output: Output = .framed

    public init(sourceWidth: Int, sourceHeight: Int, scale: Double = 1.0, fps: Int = 30,
                bitrate: Int? = nil, output: Output = .framed) {
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
        self.scale = scale
        self.fps = fps
        self.bitrate = bitrate
        self.output = output
    }

    public static let usage = """
        usage: sim-stream-encoder --source <W>x<H> [--scale <0.1-1.0>] [--fps <1-30>] [--bitrate <bps>] [--output framed|annexb]
          reads `axe stream-video --format bgra` frames on stdin, writes H.264 on stdout
        """

    /// ~0.08 bits per pixel per frame: ~1.9 Mbit/s at 603×1311@30, ~7.6 at 1206×2622@30.
    public static func defaultBitrate(width: Int, height: Int, fps: Int) -> Int {
        max(250_000, Int(Double(width * height * fps) * 0.08))
    }
}

public struct OptionsError: Error, Equatable, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

extension Options {
    /// Parses arguments (excluding argv[0]). Every value flag requires a value;
    /// unknown flags and out-of-range values are errors, never silently ignored.
    public static func parse(_ args: [String]) throws -> Options {
        var source: (Int, Int)?
        var opts = Options(sourceWidth: 0, sourceHeight: 0)
        var i = 0
        func value(_ flag: String) throws -> String {
            guard i + 1 < args.count, !args[i + 1].hasPrefix("--") else {
                throw OptionsError("\(flag) requires a value")
            }
            i += 1
            return args[i]
        }
        while i < args.count {
            let flag = args[i]
            switch flag {
            case "--source":
                let v = try value(flag)
                let parts = v.split(separator: "x", omittingEmptySubsequences: false)
                guard parts.count == 2, let w = Int(parts[0]), let h = Int(parts[1]),
                      (2...16384).contains(w), (2...16384).contains(h) else {
                    throw OptionsError("--source must be <width>x<height> in pixels, got \(v)")
                }
                source = (w, h)
            case "--scale":
                let v = try value(flag)
                guard let s = Double(v), s >= 0.1, s <= 1.0 else {
                    throw OptionsError("--scale must be between 0.1 and 1.0, got \(v)")
                }
                opts.scale = s
            case "--fps":
                let v = try value(flag)
                guard let f = Int(v), (1...30).contains(f) else {
                    throw OptionsError("--fps must be an integer 1-30, got \(v)")
                }
                opts.fps = f
            case "--bitrate":
                let v = try value(flag)
                guard let b = Int(v), b >= 50_000 else {
                    throw OptionsError("--bitrate must be an integer ≥ 50000 (bits/s), got \(v)")
                }
                opts.bitrate = b
            case "--output":
                let v = try value(flag)
                guard let o = Output(rawValue: v) else {
                    throw OptionsError("--output must be framed or annexb, got \(v)")
                }
                opts.output = o
            default:
                throw OptionsError("unknown argument \(flag)")
            }
            i += 1
        }
        guard let (w, h) = source else { throw OptionsError("--source is required") }
        opts.sourceWidth = w
        opts.sourceHeight = h
        return opts
    }
}

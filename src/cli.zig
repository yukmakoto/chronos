const std = @import("std");

pub const Command = enum {
    run,
    doctor,
    version,
    help,
};

pub const Options = struct {
    command: Command = .run,
    config_path: ?[]const u8 = null,
    verbose: bool = false,
    runtime_dir: ?[]const u8 = null,
    login_mode: ?[]const u8 = null,
};

pub const ParseError = error{
    InvalidArgument,
    MissingValue,
};

pub fn parse(args: []const []const u8) ParseError!Options {
    var opts = Options{};
    var index: usize = 1;

    if (index < args.len and !std.mem.startsWith(u8, args[index], "-")) {
        opts.command = parseCommand(args[index]) orelse return ParseError.InvalidArgument;
        index += 1;
    }

    while (index < args.len) : (index += 1) {
        const arg = args[index];

        if (std.mem.eql(u8, arg, "--config") or std.mem.eql(u8, arg, "-c")) {
            if (index + 1 >= args.len) return ParseError.MissingValue;
            index += 1;
            opts.config_path = args[index];
            continue;
        }

        if (std.mem.eql(u8, arg, "--runtime-dir")) {
            if (index + 1 >= args.len) return ParseError.MissingValue;
            index += 1;
            opts.runtime_dir = args[index];
            continue;
        }

        if (std.mem.eql(u8, arg, "--verbose") or std.mem.eql(u8, arg, "-v")) {
            opts.verbose = true;
            continue;
        }

        if (std.mem.eql(u8, arg, "--login-mode") or std.mem.eql(u8, arg, "-l")) {
            if (index + 1 >= args.len) return ParseError.MissingValue;
            index += 1;
            opts.login_mode = args[index];
            continue;
        }

        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            opts.command = .help;
            continue;
        }

        return ParseError.InvalidArgument;
    }

    return opts;
}

fn parseCommand(raw: []const u8) ?Command {
    if (std.mem.eql(u8, raw, "run")) return .run;
    if (std.mem.eql(u8, raw, "doctor")) return .doctor;
    if (std.mem.eql(u8, raw, "version")) return .version;
    if (std.mem.eql(u8, raw, "help")) return .help;
    return null;
}

pub fn printUsage(writer: anytype) !void {
    try writer.print(
        \\Usage:
        \\  chronos [run|doctor|version|help] [options]
        \\
        \\Options:
        \\  -c, --config <path>            Use custom config file
        \\  -l, --login-mode <mode>        Login mode: ask (default), quick, qr
        \\  -v, --verbose                  Enable verbose boot logging
        \\      --runtime-dir <path>       Runtime directory path
        \\  -h, --help                     Show this help message
        \\
    , .{});
}

test "parse defaults to run" {
    const args = [_][]const u8{"chronos"};
    const opts = try parse(&args);
    try std.testing.expectEqual(Command.run, opts.command);
    try std.testing.expectEqual(false, opts.verbose);
    try std.testing.expect(opts.config_path == null);
    try std.testing.expect(opts.runtime_dir == null);
}

test "parse doctor with config and verbose" {
    const args = [_][]const u8{ "chronos", "doctor", "--config", "cfg.json", "-v" };
    const opts = try parse(&args);
    try std.testing.expectEqual(Command.doctor, opts.command);
    try std.testing.expectEqualStrings("cfg.json", opts.config_path.?);
    try std.testing.expect(opts.verbose);
}

const std = @import("std");

pub const ConfigError = error{
    InvalidConfigFormat,
    PortOutOfRange,
};

pub const LogLevel = enum {
    debug,
    info,
    warn,
    @"error",
};

pub const RuntimeMode = enum {
    qqnt,
    mock,
};

pub const LoginMode = enum {
    ask,
    quick,
    qr,
};

pub const AppConfig = struct {
    listen_port: u16 = 6700,
    log_level: LogLevel = .info,
    runtime_mode: RuntimeMode = .qqnt,
    login_mode: LoginMode = .ask,
};

pub fn load(allocator: std.mem.Allocator, path_opt: ?[]const u8) !AppConfig {
    const path = path_opt orelse "config.json";

    const file = std.fs.cwd().openFile(path, .{}) catch |err| switch (err) {
        error.FileNotFound => return .{},
        else => return err,
    };
    defer file.close();

    const json_data = try file.readToEndAlloc(allocator, 256 * 1024);
    defer allocator.free(json_data);

    return parse(allocator, json_data);
}

pub fn parse(allocator: std.mem.Allocator, json_data: []const u8) !AppConfig {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, json_data, .{});
    defer parsed.deinit();

    if (parsed.value != .object) return ConfigError.InvalidConfigFormat;

    var cfg = AppConfig{};
    const root = parsed.value.object;

    if (root.get("listen_port")) |port_val| {
        cfg.listen_port = try parsePort(port_val);
    }

    if (root.get("log_level")) |log_level_val| {
        cfg.log_level = try parseLogLevel(log_level_val);
    }

    if (root.get("runtime_mode")) |runtime_mode_val| {
        cfg.runtime_mode = try parseRuntimeMode(runtime_mode_val);
    }

    if (root.get("login_mode")) |login_mode_val| {
        cfg.login_mode = try parseLoginMode(login_mode_val);
    }

    return cfg;
}

fn parsePort(value: std.json.Value) ConfigError!u16 {
    return switch (value) {
        .integer => |port| std.math.cast(u16, port) orelse ConfigError.PortOutOfRange,
        else => ConfigError.InvalidConfigFormat,
    };
}

fn parseLogLevel(value: std.json.Value) ConfigError!LogLevel {
    if (value != .string) return ConfigError.InvalidConfigFormat;

    if (std.ascii.eqlIgnoreCase(value.string, "debug")) return .debug;
    if (std.ascii.eqlIgnoreCase(value.string, "info")) return .info;
    if (std.ascii.eqlIgnoreCase(value.string, "warn")) return .warn;
    if (std.ascii.eqlIgnoreCase(value.string, "error")) return .@"error";

    return ConfigError.InvalidConfigFormat;
}

fn parseRuntimeMode(value: std.json.Value) ConfigError!RuntimeMode {
    if (value != .string) return ConfigError.InvalidConfigFormat;

    if (std.ascii.eqlIgnoreCase(value.string, "qqnt")) return .qqnt;
    if (std.ascii.eqlIgnoreCase(value.string, "mock")) return .mock;

    return ConfigError.InvalidConfigFormat;
}

fn parseLoginMode(value: std.json.Value) ConfigError!LoginMode {
    if (value != .string) return ConfigError.InvalidConfigFormat;

    if (std.ascii.eqlIgnoreCase(value.string, "ask")) return .ask;
    if (std.ascii.eqlIgnoreCase(value.string, "quick")) return .quick;
    if (std.ascii.eqlIgnoreCase(value.string, "qr")) return .qr;

    return ConfigError.InvalidConfigFormat;
}

test "parse config json" {
    const json =
        \\{
        \\  "listen_port": 8080,
        \\  "log_level": "debug",
        \\  "runtime_mode": "mock"
        \\}
    ;

    const cfg = try parse(std.testing.allocator, json);

    try std.testing.expectEqual(@as(u16, 8080), cfg.listen_port);
    try std.testing.expectEqual(LogLevel.debug, cfg.log_level);
    try std.testing.expectEqual(RuntimeMode.mock, cfg.runtime_mode);
}

test "parse rejects invalid port" {
    const json =
        \\{
        \\  "listen_port": 70000
        \\}
    ;

    try std.testing.expectError(ConfigError.PortOutOfRange, parse(std.testing.allocator, json));
}

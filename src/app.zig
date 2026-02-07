const std = @import("std");
const cli = @import("cli.zig");
const config = @import("core/config.zig");
const runtime = @import("server/runtime.zig");
const embedded_runtime = @import("packaging/embedded_runtime.zig");
const version = @import("version.zig");

pub fn run(allocator: std.mem.Allocator, options: cli.Options) !void {
    switch (options.command) {
        .help => try cli.printUsage(std.fs.File.stdout().deprecatedWriter()),
        .version => {
            const out = std.fs.File.stdout().deprecatedWriter();
            try out.print("chronos {s}\n", .{version.current});
        },
        .doctor => try doctor(allocator, options),
        .run => try runRuntime(allocator, options),
    }
}

fn runRuntime(allocator: std.mem.Allocator, options: cli.Options) !void {
    std.log.info("内嵌 QQNT.dll：{d} 字节", .{embedded_runtime.getDllSize()});

    _ = embedded_runtime.ensureExtracted() catch |err| {
        std.log.err("QQNT.dll 提取失败：{s}", .{@errorName(err)});
        return err;
    };

    const runtime_dir = options.runtime_dir orelse "runtime/qq";

    if (!try pathExists("runtime/wrapper.node")) {
        std.log.err("缺少 runtime/wrapper.node — 这是唯一需要外部提供的文件", .{});
        return error.RuntimeNotFound;
    }

    const cfg = try config.load(allocator, options.config_path);

    if (options.verbose) {
        std.log.info("已启用详细启动日志", .{});
    }

    std.log.info("配置项：log_level={s}", .{@tagName(cfg.log_level)});

    const login_mode = resolveLoginMode(options.login_mode, cfg.login_mode);
    std.log.info("登录模式：{s}", .{@tagName(login_mode)});

    var rt = try runtime.Runtime.init(allocator, cfg, runtime_dir, login_mode);
    defer rt.deinit();
    try rt.start();
}

fn resolveLoginMode(cli_mode: ?[]const u8, cfg_mode: config.LoginMode) config.LoginMode {
    if (cli_mode) |mode_str| {
        if (std.ascii.eqlIgnoreCase(mode_str, "quick")) return .quick;
        if (std.ascii.eqlIgnoreCase(mode_str, "qr")) return .qr;
        if (std.ascii.eqlIgnoreCase(mode_str, "ask")) return .ask;
    }

    const env_mode = std.process.getEnvVarOwned(std.heap.page_allocator, "CHRONOS_LOGIN_MODE") catch null;
    if (env_mode) |mode_str| {
        defer std.heap.page_allocator.free(mode_str);
        if (std.ascii.eqlIgnoreCase(mode_str, "quick")) return .quick;
        if (std.ascii.eqlIgnoreCase(mode_str, "qr")) return .qr;
        if (std.ascii.eqlIgnoreCase(mode_str, "ask")) return .ask;
    }

    return cfg_mode;
}

fn doctor(allocator: std.mem.Allocator, options: cli.Options) !void {
    const out = std.fs.File.stdout().deprecatedWriter();

    const runtime_dir = options.runtime_dir orelse "runtime/qq";
    const runtime_dir_ok = try pathExists(runtime_dir);
    const wrapper_ok = try pathExists("runtime/wrapper.node");
    const shim_ok = try pathExists("shim/QQNT.dll");

    try out.print("Chronos doctor\n", .{});
    try out.print("  build mode: embedded QQNT.dll\n", .{});
    try out.print("  embedded QQNT.dll: {d} bytes\n", .{embedded_runtime.getDllSize()});
    try out.print("  runtime dir ({s}): {s}\n", .{ runtime_dir, if (runtime_dir_ok) "ok" else "not found" });
    try out.print("  wrapper.node: {s}\n", .{if (wrapper_ok) "ok" else "MISSING (required)"});
    try out.print("  shim/QQNT.dll: {s}\n", .{if (shim_ok) "ok" else "MISSING"});

    _ = allocator;
}

fn pathExists(path: []const u8) !bool {
    std.fs.cwd().access(path, .{}) catch |err| switch (err) {
        error.FileNotFound => return false,
        else => return err,
    };
    return true;
}

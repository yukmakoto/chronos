const std = @import("std");
const cli = @import("cli.zig");
const app = @import("app.zig");

fn fileExists(path: []const u8) bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

fn fileExistsAbsolute(path: []const u8) bool {
    var file = std.fs.openFileAbsolute(path, .{}) catch return false;
    file.close();
    return true;
}

fn looksLikeProjectRoot(allocator: std.mem.Allocator, base_dir: []const u8) !bool {
    const wrapper_path = try std.fs.path.join(allocator, &[_][]const u8{ base_dir, "runtime", "wrapper.node" });
    defer allocator.free(wrapper_path);

    return fileExistsAbsolute(wrapper_path);
}

fn tryAutoSetWorkingDir(allocator: std.mem.Allocator) !void {
    if (fileExists("runtime/wrapper.node")) {
        return;
    }

    const exe_path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(exe_path);

    var candidate_opt: ?[]const u8 = std.fs.path.dirname(exe_path);
    var depth: usize = 0;

    while (candidate_opt) |candidate| : (depth += 1) {
        if (try looksLikeProjectRoot(allocator, candidate)) {
            var dir = try std.fs.openDirAbsolute(candidate, .{});
            defer dir.close();

            try dir.setAsCwd();
            std.log.info("已自动切换工作目录：{s}", .{candidate});
            return;
        }

        if (depth >= 6) break;
        candidate_opt = std.fs.path.dirname(candidate);
    }
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer {
        const state = gpa.deinit();
        if (state == .leak) {
            std.log.err("检测到内存泄漏", .{});
        }
    }

    const allocator = gpa.allocator();

    const argv = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, argv);

    const options = cli.parse(argv) catch |err| {
        const err_out = std.fs.File.stderr().deprecatedWriter();
        try err_out.print("Argument error: {s}\n\n", .{@errorName(err)});
        try cli.printUsage(err_out);
        return err;
    };

    const likely_double_click = options.command == .run and options.config_path == null and options.runtime_dir == null;
    if (likely_double_click) {
        tryAutoSetWorkingDir(allocator) catch |err| {
            std.log.warn("自动切换工作目录已跳过：{s}", .{@errorName(err)});
        };
    }

    try app.run(allocator, options);
}

test {
    _ = @import("cli.zig");
    _ = @import("core/config.zig");
    _ = @import("core/json_utils.zig");
    _ = @import("packaging/embedded_runtime.zig");
}




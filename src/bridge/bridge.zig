/// QQNT bridge process manager.
///
/// Manages the Node.js child process that hosts the QQNT wrapper,
/// handles IPC via filesystem (in/out directories), and pumps
/// stdout/stderr with noise filtering.
const std = @import("std");
const config = @import("../core/config.zig");
const json = @import("../core/json_utils.zig");

const embedded_bridge_bundle = @embedFile("qqnt_bridge.bundle.bin");
const bridge_runner_inline_script = @embedFile("bridge_runner_inline.js");
const bridge_base_dir = "runtime/bridge/ipc";
const bridge_in_dir = "runtime/bridge/ipc/in";
const bridge_out_dir = "runtime/bridge/ipc/out";

const max_outbox_message_bytes = 1024 * 1024;
const wait_timeout_ms: i64 = 12_000;
const poll_interval_ns: u64 = 100 * std.time.ns_per_ms;

pub const Response = struct {
    id: u64,
    ok: bool,
    message_id: ?u64 = null,
    error_text: ?[]u8 = null,

    pub fn deinit(self: *Response, allocator: std.mem.Allocator) void {
        if (self.error_text) |text| {
            allocator.free(text);
            self.error_text = null;
        }
    }
};

/// Callback interface for bridge → server communication.
pub const Delegate = struct {
    ptr: *anyopaque,
    appendEventFn: *const fn (*anyopaque, []u8) anyerror!void,

    pub fn appendEvent(self: Delegate, event_json: []u8) !void {
        return self.appendEventFn(self.ptr, event_json);
    }
};

pub const Bridge = struct {
    allocator: std.mem.Allocator,
    cfg: config.AppConfig,
    qq_base_dir: []u8,
    login_mode: config.LoginMode,

    child: ?std.process.Child,
    stdout_thread: ?std.Thread,
    stderr_thread: ?std.Thread,
    started: bool,
    services_ready: bool,
    active_self_id: ?u64,

    next_command_id: u64,
    pending_responses: std.ArrayList(Response),

    /// Path to the temp bundle file written at startup.
    temp_bundle_path: ?[]u8,

    pub fn init(
        allocator: std.mem.Allocator,
        cfg: config.AppConfig,
        qq_base_dir: []const u8,
        login_mode: config.LoginMode,
    ) !Bridge {
        return .{
            .allocator = allocator,
            .cfg = cfg,
            .qq_base_dir = try allocator.dupe(u8, qq_base_dir),
            .login_mode = login_mode,
            .child = null,
            .stdout_thread = null,
            .stderr_thread = null,
            .started = false,
            .services_ready = false,
            .active_self_id = null,
            .next_command_id = 1,
            .pending_responses = .empty,
            .temp_bundle_path = null,
        };
    }

    pub fn deinit(self: *Bridge) void {
        self.stop();
        self.allocator.free(self.qq_base_dir);
        for (self.pending_responses.items) |*r| r.deinit(self.allocator);
        self.pending_responses.deinit(self.allocator);
        self.cleanupTempBundle();
    }

    fn cleanupTempBundle(self: *Bridge) void {
        if (self.temp_bundle_path) |p| {
            std.fs.cwd().deleteFile(p) catch {};
            self.allocator.free(p);
            self.temp_bundle_path = null;
        }
    }

    /// Write the embedded bundle to a temp file and return its absolute path.
    fn writeTempBundle(self: *Bridge) ![]u8 {
        const temp_dir = "runtime/bridge";
        try std.fs.cwd().makePath(temp_dir);

        const temp_path = temp_dir ++ "/qqnt_bridge.bundle.bin";
        try std.fs.cwd().writeFile(.{ .sub_path = temp_path, .data = embedded_bridge_bundle });

        const abs = try std.fs.cwd().realpathAlloc(self.allocator, temp_path);
        self.temp_bundle_path = abs;
        return abs;
    }

    // ── Lifecycle ──

    pub fn ensureStarted(self: *Bridge) !void {
        if (self.started) return;

        // Write embedded bundle to temp file for Node to read
        const bundle_abs = try self.writeTempBundle();

        try std.fs.cwd().makePath(bridge_in_dir);
        try std.fs.cwd().makePath(bridge_out_dir);
        try clearDirectoryFiles(bridge_in_dir);
        try clearDirectoryFiles(bridge_out_dir);

        var env_map = try std.process.getEnvMap(self.allocator);
        defer env_map.deinit();

        const abs = struct {
            fn resolve(a: std.mem.Allocator, rel: []const u8) ![]u8 {
                return std.fs.cwd().realpathAlloc(a, rel);
            }
        };

        const bridge_base = try abs.resolve(self.allocator, bridge_base_dir);
        defer self.allocator.free(bridge_base);
        const runtime_cwd = try abs.resolve(self.allocator, "runtime");
        defer self.allocator.free(runtime_cwd);
        const wrapper = try abs.resolve(self.allocator, "runtime/wrapper.node");
        defer self.allocator.free(wrapper);
        const qq_base = try abs.resolve(self.allocator, self.qq_base_dir);
        defer self.allocator.free(qq_base);

        const recv_only = if (self.cfg.log_level == .debug) "0" else "1";
        const verbose = if (self.cfg.log_level == .debug) "1" else "0";

        try env_map.put("CHRONOS_BRIDGE_MODE", "1");
        try env_map.put("CHRONOS_BRIDGE_DIR", bridge_base);
        try env_map.put("CHRONOS_RECV_ONLY_LOG", recv_only);
        try env_map.put("CHRONOS_VERBOSE_LOG", verbose);
        try env_map.put("CHRONOS_RUNTIME_DIR", runtime_cwd);
        try env_map.put("CHRONOS_WRAPPER_INMEM", "0");
        try env_map.put("CHRONOS_WRAPPER_PATH", wrapper);
        try env_map.put("CHRONOS_QQ_BASE", qq_base);
        try env_map.put("CHRONOS_BRIDGE_BUNDLE", bundle_abs);
        try env_map.put("CHRONOS_BRIDGE_ANTITAMPER", "1");
        try env_map.put("CHRONOS_LOGIN_MODE", @tagName(self.login_mode));

        // Tell JS where the shim QQNT.dll was extracted to
        const shim_dir = try abs.resolve(self.allocator, "shim");
        defer self.allocator.free(shim_dir);
        try env_map.put("CHRONOS_SHIM_DIR", shim_dir);

        const argv = [_][]const u8{ "node", "-e", bridge_runner_inline_script };
        var proc = std.process.Child.init(&argv, self.allocator);
        proc.cwd = runtime_cwd;
        proc.stdin_behavior = .Inherit;
        proc.stdout_behavior = .Pipe;
        proc.stderr_behavior = .Pipe;
        proc.env_map = &env_map;
        try proc.spawn();

        self.child = proc;
        self.started = true;
        self.services_ready = false;

        if (self.child) |*c| {
            if (c.stdout) |pipe| {
                c.stdout = null;
                self.stdout_thread = std.Thread.spawn(.{}, pumpStream, .{ pipe, false }) catch |err| blk: {
                    pipe.close();
                    std.log.warn("桥接 stdout 线程启动失败：{s}", .{@errorName(err)});
                    break :blk null;
                };
            }
            if (c.stderr) |pipe| {
                c.stderr = null;
                self.stderr_thread = std.Thread.spawn(.{}, pumpStream, .{ pipe, true }) catch |err| blk: {
                    pipe.close();
                    std.log.warn("桥接 stderr 线程启动失败：{s}", .{@errorName(err)});
                    break :blk null;
                };
            }
        }

        std.log.info("QQNT bridge started (embedded bundle, {d} bytes)", .{embedded_bridge_bundle.len});
    }

    pub fn stop(self: *Bridge) void {
        if (self.child) |*c| {
            _ = c.kill() catch {};
            _ = c.wait() catch {};
            self.child = null;
        }
        if (self.stdout_thread) |t| { t.join(); self.stdout_thread = null; }
        if (self.stderr_thread) |t| { t.join(); self.stderr_thread = null; }
        self.started = false;
        self.services_ready = false;
    }

    // ── Messaging ──

    pub fn sendMessage(self: *Bridge, delegate: Delegate, action: []const u8, target_id: u64, message: []const u8) !u64 {
        try self.ensureStarted();
        try self.pollOutbox(delegate);

        const cmd_id = self.next_command_id;
        self.next_command_id += 1;

        try self.writeCommand(cmd_id, action, target_id, message);

        var response = try self.awaitResponse(delegate, cmd_id, wait_timeout_ms);
        defer response.deinit(self.allocator);

        if (!response.ok) {
            if (response.error_text) |text| {
                std.log.err("桥接响应失败 id={d} action={s}：{s}", .{ cmd_id, action, text });
            }
            return error.BridgeSendFailed;
        }

        return response.message_id orelse @as(u64, @intCast(@as(i64, @truncate(std.time.milliTimestamp()))));
    }

    fn writeCommand(self: *Bridge, cmd_id: u64, action: []const u8, target_id: u64, message: []const u8) !void {
        const msg_json = try json.stringify(self.allocator, message);
        defer self.allocator.free(msg_json);

        const body = try std.fmt.allocPrint(
            self.allocator,
            "{{\"id\":{d},\"action\":\"{s}\",\"target_id\":{d},\"message\":{s}}}",
            .{ cmd_id, action, target_id, msg_json },
        );
        defer self.allocator.free(body);

        const filename = try std.fmt.allocPrint(self.allocator, "cmd_{d}.json", .{cmd_id});
        defer self.allocator.free(filename);

        const filepath = try std.fs.path.join(self.allocator, &[_][]const u8{ bridge_in_dir, filename });
        defer self.allocator.free(filepath);

        try std.fs.cwd().writeFile(.{ .sub_path = filepath, .data = body });
    }

    fn awaitResponse(self: *Bridge, delegate: Delegate, cmd_id: u64, timeout_ms: i64) !Response {
        const deadline = std.time.milliTimestamp() + timeout_ms;
        while (std.time.milliTimestamp() <= deadline) {
            try self.pollOutbox(delegate);
            if (self.takeResponse(cmd_id)) |r| return r;
            std.Thread.sleep(poll_interval_ns);
        }
        return error.BridgeTimeout;
    }

    fn takeResponse(self: *Bridge, cmd_id: u64) ?Response {
        for (self.pending_responses.items, 0..) |r, i| {
            if (r.id == cmd_id) return self.pending_responses.swapRemove(i);
        }
        return null;
    }

    // ── Outbox polling ──

    pub fn pollOutbox(self: *Bridge, delegate: anytype) !void {
        if (!self.started) return;

        var dir = std.fs.cwd().openDir(bridge_out_dir, .{ .iterate = true }) catch |err| switch (err) {
            error.FileNotFound => return,
            else => return err,
        };
        defer dir.close();

        var iter = dir.iterate();
        while (try iter.next()) |entry| {
            if (entry.kind != .file) continue;

            var file = dir.openFile(entry.name, .{}) catch |err| {
                if (err == error.FileNotFound) continue;
                return err;
            };
            defer file.close();

            const content = try file.readToEndAlloc(self.allocator, max_outbox_message_bytes);
            defer self.allocator.free(content);

            self.handleOutboxMessage(delegate, content) catch |err| {
                std.log.warn("已忽略桥接输出消息 '{s}'：{s}", .{ entry.name, @errorName(err) });
            };

            dir.deleteFile(entry.name) catch {};
        }
    }

    fn handleOutboxMessage(self: *Bridge, delegate: anytype, content: []const u8) !void {
        var parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, content, .{});
        defer parsed.deinit();

        if (parsed.value != .object) return error.BridgeMessageInvalid;
        const root = parsed.value.object;

        const type_val = root.get("type") orelse return error.BridgeMessageMissingType;
        if (type_val != .string) return error.BridgeMessageInvalidType;

        if (std.mem.eql(u8, type_val.string, "event")) {
            const event_val = root.get("event") orelse return error.BridgeEventMissingPayload;
            const event_json = try json.stringify(self.allocator, event_val);
            try delegate.appendEvent(event_json);
            return;
        }

        if (std.mem.eql(u8, type_val.string, "response")) {
            const id_val = root.get("id") orelse return error.BridgeResponseMissingId;
            const ok_val = root.get("ok") orelse return error.BridgeResponseMissingOk;

            var response = Response{
                .id = try json.toU64(id_val),
                .ok = try json.toBool(ok_val),
            };

            if (root.get("message_id")) |v| {
                response.message_id = json.toU64(v) catch null;
            }
            if (root.get("error")) |v| {
                response.error_text = try json.toOwnedString(self.allocator, v);
            }

            try self.pending_responses.append(self.allocator, response);
            return;
        }

        if (std.mem.eql(u8, type_val.string, "status")) {
            if (root.get("self_id")) |v| {
                if (json.toU64(v)) |id| { self.active_self_id = id; } else |_| {}
            }
            if (root.get("status")) |v| {
                if (v == .string and std.mem.eql(u8, v.string, "services_ready")) {
                    self.services_ready = true;
                    if (self.active_self_id) |id| {
                        std.log.info("桥接已就绪，当前登录账号={d}", .{id});
                    }
                }
                if (v == .string and std.mem.eql(u8, v.string, "kicked_offline")) {
                    self.services_ready = false;
                    std.log.err("══════════════════════════════════════════════════", .{});
                    std.log.err("  当前 QQ 账号已在其他设备上登录，本机已被强制下线", .{});
                    std.log.err("  请先在其他设备上退出登录，然后重新启动 Chronos", .{});
                    std.log.err("══════════════════════════════════════════════════", .{});
                }
                if (v == .string and std.mem.eql(u8, v.string, "session_init_failed")) {
                    self.services_ready = false;
                    std.log.err("══════════════════════════════════════════════════", .{});
                    std.log.err("  会话初始化失败，服务未能就绪", .{});
                    std.log.err("  可能原因：登录凭证已失效或 session 数据损坏", .{});
                    std.log.err("  建议：删除 runtime/userdata 目录后重新启动", .{});
                    std.log.err("══════════════════════════════════════════════════", .{});
                }
            }
        }
    }
};

// ── Stream pump (runs in dedicated thread) ──

const blocked_noise = [_][]const u8{
    "loadSymbolFromShell: GetProcAddress failed PerfTrace",
    "loadSymbolFromShell: GetProcAddress failed NodeContextifyContextMetrics1",
    "getNodeGetJsListApi: get symbol failed",
};

fn isNoise(line: []const u8) bool {
    for (blocked_noise) |pattern| {
        if (std.mem.indexOf(u8, line, pattern) != null) return true;
    }
    return false;
}

fn pumpStream(pipe: std.fs.File, to_stderr: bool) void {
    defer pipe.close();

    var target = if (to_stderr) std.fs.File.stderr() else std.fs.File.stdout();
    var read_buf: [4096]u8 = undefined;
    var line_buf: [8192]u8 = undefined;
    var line_len: usize = 0;

    while (true) {
        const n = pipe.read(&read_buf) catch break;
        if (n == 0) break;

        for (read_buf[0..n]) |byte| {
            if (byte == '\n') {
                const line = line_buf[0..line_len];
                if (!isNoise(line)) {
                    _ = target.write(line) catch {};
                    _ = target.write("\n") catch {};
                }
                line_len = 0;
            } else if (line_len < line_buf.len) {
                line_buf[line_len] = byte;
                line_len += 1;
            } else {
                if (!isNoise(line_buf[0..line_len])) {
                    _ = target.write(line_buf[0..line_len]) catch {};
                }
                line_len = 0;
            }
        }
    }

    if (line_len > 0 and !isNoise(line_buf[0..line_len])) {
        _ = target.write(line_buf[0..line_len]) catch {};
    }
}

fn clearDirectoryFiles(path: []const u8) !void {
    var dir = std.fs.cwd().openDir(path, .{ .iterate = true }) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    defer dir.close();

    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        if (entry.kind != .file) continue;
        dir.deleteFile(entry.name) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };
    }
}

/// Runtime orchestrator.
///
/// Wires together the QQNT bridge and the OneBot v11 HTTP server.
/// This module is intentionally thin — all logic lives in `bridge.zig`
/// and `onebot.zig`.
const std = @import("std");
const config = @import("../core/config.zig");
const bridge_mod = @import("../bridge/bridge.zig");
const onebot = @import("onebot.zig");

pub const Runtime = struct {
    allocator: std.mem.Allocator,
    cfg: config.AppConfig,
    bridge: bridge_mod.Bridge,
    server: onebot.Server,

    pub fn init(
        allocator: std.mem.Allocator,
        cfg: config.AppConfig,
        qq_base_dir: []const u8,
        login_mode: config.LoginMode,
    ) !Runtime {
        var bridge = try bridge_mod.Bridge.init(allocator, cfg, qq_base_dir, login_mode);
        return .{
            .allocator = allocator,
            .cfg = cfg,
            .bridge = bridge,
            .server = onebot.Server.init(allocator, cfg, &bridge),
        };
    }

    pub fn deinit(self: *Runtime) void {
        self.server.deinit();
        self.bridge.deinit();
    }

    pub fn start(self: *Runtime) !void {
        if (self.cfg.runtime_mode == .qqnt) {
            try self.bridge.ensureStarted();
        }

        // Fix server pointer after struct move
        self.server.bridge = &self.bridge;

        const addr = try std.net.Address.parseIp4("0.0.0.0", self.cfg.listen_port);
        var listener = try addr.listen(.{ .reuse_address = true });
        defer listener.deinit();

        std.log.info("OneBot v11 服务已启动，监听地址 0.0.0.0:{d}", .{self.cfg.listen_port});
        std.log.info("运行模式={s}", .{@tagName(self.cfg.runtime_mode)});

        while (true) {
            const conn = try listener.accept();
            self.server.serveConnection(conn);
        }
    }
};

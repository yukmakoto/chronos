/// OneBot v11 HTTP API server.
///
/// Implements the OneBot v11 HTTP API specification.
/// Reference: https://github.com/botuniverse/onebot-11
const std = @import("std");
const config = @import("../core/config.zig");
const json = @import("../core/json_utils.zig");
const bridge_mod = @import("../bridge/bridge.zig");
const version = @import("../version.zig");

const max_request_body_bytes = 1024 * 1024;

const json_headers = [_]std.http.Header{
    .{ .name = "Content-Type", .value = "application/json; charset=utf-8" },
};

const SendParsed = struct { target_id: u64, message: []u8 };
const GroupEmitParsed = struct { group_id: u64, user_id: u64, message: []u8 };

pub const Server = struct {
    allocator: std.mem.Allocator,
    cfg: config.AppConfig,
    bridge: *bridge_mod.Bridge,
    next_message_id: u64,
    pending_events: std.ArrayList([]u8),

    pub fn init(allocator: std.mem.Allocator, cfg: config.AppConfig, bridge: *bridge_mod.Bridge) Server {
        return .{
            .allocator = allocator,
            .cfg = cfg,
            .bridge = bridge,
            .next_message_id = 1,
            .pending_events = .empty,
        };
    }

    pub fn deinit(self: *Server) void {
        self.clearEvents();
        self.pending_events.deinit(self.allocator);
    }

    pub fn selfId(self: *Server) u64 {
        return self.bridge.active_self_id orelse 0;
    }

    pub fn issueMessageId(self: *Server) u64 {
        defer self.next_message_id += 1;
        return self.next_message_id;
    }

    pub fn appendEvent(self: *Server, event_json: []u8) !void {
        try self.pending_events.append(self.allocator, event_json);
    }

    /// Returns a bridge delegate that routes events to this server.
    pub fn bridgeDelegate(self: *Server) bridge_mod.Delegate {
        return .{
            .ptr = @ptrCast(self),
            .appendEventFn = @ptrCast(&appendEventTrampoline),
        };
    }

    fn appendEventTrampoline(self: *Server, event_json: []u8) !void {
        return self.appendEvent(event_json);
    }

    // ── HTTP connection loop ──

    pub fn serveConnection(self: *Server, connection: std.net.Server.Connection) void {
        defer connection.stream.close();

        var recv_buf: [8192]u8 = undefined;
        var send_buf: [8192]u8 = undefined;
        var reader = connection.stream.reader(&recv_buf);
        var writer = connection.stream.writer(&send_buf);
        var http: std.http.Server = .init(reader.interface(), &writer.interface);

        while (true) {
            var req = http.receiveHead() catch |err| switch (err) {
                error.HttpConnectionClosing => return,
                else => {
                    std.log.err("HTTP 接收失败：{s}", .{@errorName(err)});
                    return;
                },
            };
            self.dispatch(&req) catch |err| {
                std.log.err("请求处理失败：{s}", .{@errorName(err)});
                self.respondFailed(&req, .bad_request, 1400, @errorName(err)) catch {};
            };
        }
    }

    // ── Routing ──

    fn dispatch(self: *Server, req: *std.http.Server.Request) !void {
        const path = json.trimQuery(req.head.target);

        // OneBot v11: all endpoints accept both GET and POST
        if (std.mem.eql(u8, path, "/get_status")) return self.apiGetStatus(req);
        if (std.mem.eql(u8, path, "/get_login_info")) return self.apiGetLoginInfo(req);
        if (std.mem.eql(u8, path, "/get_version_info")) return self.apiGetVersionInfo(req);
        if (std.mem.eql(u8, path, "/get_updates")) return self.apiGetUpdates(req);
        if (std.mem.eql(u8, path, "/send_private_msg")) return self.apiSendPrivateMsg(req);
        if (std.mem.eql(u8, path, "/send_group_msg")) return self.apiSendGroupMsg(req);

        return self.respondFailed(req, .not_found, 1404, "unknown_api");
    }

    // ── API: get_status ──

    fn apiGetStatus(self: *Server, req: *std.http.Server.Request) !void {
        const delegate = self.bridgeDelegate();
        self.bridge.pollOutbox(delegate) catch {};

        const good = self.bridge.services_ready;
        const data = try std.fmt.allocPrint(self.allocator,
            "{{\"online\":{s},\"good\":{s}}}",
            .{ if (good) "true" else "false", if (good) "true" else "false" },
        );
        defer self.allocator.free(data);
        try self.respondOk(req, data);
    }

    // ── API: get_login_info ──

    fn apiGetLoginInfo(self: *Server, req: *std.http.Server.Request) !void {
        const data = try std.fmt.allocPrint(self.allocator,
            "{{\"user_id\":{d},\"nickname\":\"chronos\"}}",
            .{self.selfId()},
        );
        defer self.allocator.free(data);
        try self.respondOk(req, data);
    }

    // ── API: get_version_info ──

    fn apiGetVersionInfo(self: *Server, req: *std.http.Server.Request) !void {
        const data = try std.fmt.allocPrint(self.allocator,
            "{{\"app_name\":\"chronos\",\"app_version\":\"{s}\",\"protocol_version\":\"v11\"}}",
            .{version.current},
        );
        defer self.allocator.free(data);
        try self.respondOk(req, data);
    }

    // ── API: get_updates (extension) ──

    fn apiGetUpdates(self: *Server, req: *std.http.Server.Request) !void {
        const delegate = self.bridgeDelegate();
        self.bridge.pollOutbox(delegate) catch {};

        const events = try self.drainEventsJson();
        defer self.allocator.free(events);

        const data = try std.fmt.allocPrint(self.allocator, "{{\"events\":{s}}}", .{events});
        defer self.allocator.free(data);
        try self.respondOk(req, data);
    }

    // ── API: send_private_msg ──

    fn apiSendPrivateMsg(self: *Server, req: *std.http.Server.Request) !void {
        const body = try self.readBody(req);
        defer self.allocator.free(body);

        const parsed = try self.parseSend(body, "user_id");
        defer self.allocator.free(parsed.message);

        std.log.info("发送私聊消息 user_id={d}", .{parsed.target_id});

        const delegate = self.bridgeDelegate();
        const msg_id = self.bridge.sendMessage(delegate, "send_private_msg", parsed.target_id, parsed.message) catch |err| {
            std.log.err("桥接发送私聊失败：{s}", .{@errorName(err)});
            return self.respondFailed(req, .bad_gateway, 2500, @errorName(err));
        };

        const data = try std.fmt.allocPrint(self.allocator, "{{\"message_id\":{d}}}", .{msg_id});
        defer self.allocator.free(data);
        try self.respondOk(req, data);
    }

    // ── API: send_group_msg ──

    fn apiSendGroupMsg(self: *Server, req: *std.http.Server.Request) !void {
        const body = try self.readBody(req);
        defer self.allocator.free(body);

        const parsed = try self.parseSend(body, "group_id");
        defer self.allocator.free(parsed.message);

        std.log.info("发送群聊消息 group_id={d}", .{parsed.target_id});

        const delegate = self.bridgeDelegate();
        const msg_id = self.bridge.sendMessage(delegate, "send_group_msg", parsed.target_id, parsed.message) catch |err| {
            std.log.err("桥接发送群聊失败：{s}", .{@errorName(err)});
            return self.respondFailed(req, .bad_gateway, 2500, @errorName(err));
        };

        const data = try std.fmt.allocPrint(self.allocator, "{{\"message_id\":{d}}}", .{msg_id});
        defer self.allocator.free(data);
        try self.respondOk(req, data);
    }

    // ── Response helpers (OneBot v11 format) ──

    fn respondOk(self: *Server, req: *std.http.Server.Request, data: []const u8) !void {
        const payload = try std.fmt.allocPrint(self.allocator,
            "{{\"status\":\"ok\",\"retcode\":0,\"data\":{s},\"echo\":null}}",
            .{data},
        );
        defer self.allocator.free(payload);
        try req.respond(payload, .{ .status = .ok, .extra_headers = &json_headers });
    }

    fn respondFailed(self: *Server, req: *std.http.Server.Request, status: std.http.Status, retcode: i32, msg: []const u8) !void {
        const msg_json = try json.stringify(self.allocator, msg);
        defer self.allocator.free(msg_json);

        const payload = try std.fmt.allocPrint(self.allocator,
            "{{\"status\":\"failed\",\"retcode\":{d},\"data\":null,\"message\":{s},\"wording\":{s},\"echo\":null}}",
            .{ retcode, msg_json, msg_json },
        );
        defer self.allocator.free(payload);
        try req.respond(payload, .{ .status = status, .extra_headers = &json_headers });
    }

    // ── Request parsing ──

    fn readBody(self: *Server, req: *std.http.Server.Request) ![]u8 {
        if (req.head.expect != null) try req.writeExpectContinue();
        var buf: [4096]u8 = undefined;
        const reader = req.readerExpectNone(&buf);
        return try reader.allocRemaining(self.allocator, .limited(max_request_body_bytes));
    }

    fn parseSend(self: *Server, body: []const u8, target_field: []const u8) !SendParsed {
        var parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, body, .{});
        defer parsed.deinit();
        if (parsed.value != .object) return error.InvalidRequestBody;
        const root = parsed.value.object;
        return .{
            .target_id = try json.toU64(root.get(target_field) orelse return error.MissingTargetId),
            .message = try json.toMessage(self.allocator, root.get("message") orelse return error.MissingMessage),
        };
    }

    // ── Event management ──

    fn drainEventsJson(self: *Server) ![]u8 {
        var buf: std.ArrayList(u8) = .empty;
        errdefer buf.deinit(self.allocator);

        try buf.append(self.allocator, '[');
        for (self.pending_events.items, 0..) |ev, i| {
            if (i != 0) try buf.append(self.allocator, ',');
            try buf.appendSlice(self.allocator, ev);
        }
        try buf.append(self.allocator, ']');

        self.clearEvents();
        return buf.toOwnedSlice(self.allocator);
    }

    fn clearEvents(self: *Server) void {
        for (self.pending_events.items) |ev| self.allocator.free(ev);
        self.pending_events.clearRetainingCapacity();
    }
};

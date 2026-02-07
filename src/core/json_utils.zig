/// JSON value conversion utilities.
///
/// Provides type-safe extraction of Zig types from `std.json.Value`,
/// handling numeric strings, floats-as-integers, and boolean coercion
/// as required by the OneBot v11 specification.
const std = @import("std");

pub fn toU64(value: std.json.Value) !u64 {
    return switch (value) {
        .integer => |v| std.math.cast(u64, v) orelse error.InvalidNumericValue,
        .float => |v| blk: {
            if (v < 0) break :blk error.InvalidNumericValue;
            const i = @as(u64, @intFromFloat(v));
            if (@as(f64, @floatFromInt(i)) != v) break :blk error.InvalidNumericValue;
            break :blk i;
        },
        .string => |text| std.fmt.parseInt(u64, text, 10),
        else => error.InvalidNumericValue,
    };
}

pub fn toBool(value: std.json.Value) !bool {
    return switch (value) {
        .bool => |v| v,
        .string => |text| blk: {
            if (std.ascii.eqlIgnoreCase(text, "true") or std.mem.eql(u8, text, "1")) break :blk true;
            if (std.ascii.eqlIgnoreCase(text, "false") or std.mem.eql(u8, text, "0")) break :blk false;
            break :blk error.InvalidBooleanValue;
        },
        else => error.InvalidBooleanValue,
    };
}

pub fn toMessage(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    return switch (value) {
        .string => |text| allocator.dupe(u8, text),
        else => stringify(allocator, value),
    };
}

pub fn toOwnedString(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    return switch (value) {
        .string => |text| allocator.dupe(u8, text),
        else => stringify(allocator, value),
    };
}

pub fn stringify(allocator: std.mem.Allocator, value: anytype) ![]u8 {
    return std.fmt.allocPrint(allocator, "{f}", .{std.json.fmt(value, .{})});
}

pub fn trimQuery(target: []const u8) []const u8 {
    return target[0 .. std.mem.indexOfScalar(u8, target, '?') orelse target.len];
}

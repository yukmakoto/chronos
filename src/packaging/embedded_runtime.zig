/// Embedded QQNT.dll shim extraction.
///
/// The shim DLL is committed to the repo and embedded at compile time.
/// At runtime it is written to shim/QQNT.dll if not already present.
const std = @import("std");

const embedded_qqnt_dll = @embedFile("QQNT.dll");
const shim_dll_path = "shim/QQNT.dll";

/// Write embedded QQNT.dll to disk if not already present.
/// Returns true if the file was written, false if skipped.
pub fn ensureExtracted() !bool {
    std.fs.cwd().access(shim_dll_path, .{}) catch |err| switch (err) {
        error.FileNotFound => {
            std.log.info("正在写入内嵌 QQNT.dll shim...", .{});

            if (std.fs.path.dirname(shim_dll_path)) |parent| {
                try std.fs.cwd().makePath(parent);
            }

            try std.fs.cwd().writeFile(.{
                .sub_path = shim_dll_path,
                .data = embedded_qqnt_dll,
            });

            std.log.info("QQNT.dll 已写入：{s}（{d} 字节）", .{ shim_dll_path, embedded_qqnt_dll.len });
            return true;
        },
        else => return err,
    };
    return false;
}

pub fn getDllSize() usize {
    return embedded_qqnt_dll.len;
}

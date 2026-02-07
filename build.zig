const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "chronos",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    // ── Auto-pack bridge bundle from JS source if needed ──

    const has_js_source = fileExists("src/bridge/js/pack_bridge_bundle.js");
    const has_bridge_bundle = fileExists("src/bridge/qqnt_bridge.bundle.bin");

    if (has_js_source and !has_bridge_bundle) {
        const pack_bridge_cmd = b.addSystemCommand(&[_][]const u8{
            "node", "src/bridge/js/pack_bridge_bundle.js",
        });
        b.getInstallStep().dependOn(&pack_bridge_cmd.step);

        const pack_bridge_step = b.step("pack-bridge", "Pack bridge JS into binary bundle");
        pack_bridge_step.dependOn(&pack_bridge_cmd.step);
    }

    b.installArtifact(exe);

    // ── Run step ──

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run Chronos");
    run_step.dependOn(&run_cmd.step);

    // ── Test step ──

    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    const test_run = b.addRunArtifact(tests);

    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&test_run.step);
}

fn fileExists(rel_path: []const u8) bool {
    std.fs.cwd().access(rel_path, .{}) catch return false;
    return true;
}

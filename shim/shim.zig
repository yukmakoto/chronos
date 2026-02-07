const std = @import("std");

extern "kernel32" fn GetModuleHandleA(lpModuleName: ?[*:0]const u8) callconv(.winapi) ?*anyopaque;
extern "kernel32" fn GetProcAddress(hModule: ?*anyopaque, lpProcName: [*:0]const u8) callconv(.winapi) ?*anyopaque;

const NapiModule = extern struct {
    nm_version: c_int,
    nm_flags: u32,
    nm_filename: ?[*:0]const u8,
    nm_register_func: ?*anyopaque,
    nm_modname: ?[*:0]const u8,
    nm_priv: ?*anyopaque,
    reserved: [4]?*anyopaque,
};

var node_handle_initialized = false;
var node_handle: ?*anyopaque = null;

fn resolveNodeHandle() ?*anyopaque {
    if (!node_handle_initialized) {
        node_handle_initialized = true;
        node_handle = GetModuleHandleA("node.exe");
        if (node_handle == null) {
            node_handle = GetModuleHandleA(null);
        }
    }
    return node_handle;
}

fn resolveNodeProcZ(name: [*:0]const u8) ?*anyopaque {
    const handle = resolveNodeHandle() orelse return null;
    return GetProcAddress(handle, name);
}

fn resolveNodeProc(comptime name: []const u8) ?*anyopaque {
    const z_name: [*:0]const u8 = @ptrCast((name ++ "\x00").ptr);
    return resolveNodeProcZ(z_name);
}

fn callNode8(
    comptime symbol: []const u8,
    a1: usize,
    a2: usize,
    a3: usize,
    a4: usize,
    a5: usize,
    a6: usize,
    a7: usize,
    a8: usize,
) usize {
    const proc = resolveNodeProc(symbol) orelse return 0;
    const ForwardFn = *const fn (usize, usize, usize, usize, usize, usize, usize, usize) callconv(.c) usize;
    const forward_fn: ForwardFn = @ptrCast(@alignCast(proc));
    return forward_fn(a1, a2, a3, a4, a5, a6, a7, a8);
}

fn makeForward8(comptime symbol: []const u8) type {
    return struct {
        fn call(
            a1: usize,
            a2: usize,
            a3: usize,
            a4: usize,
            a5: usize,
            a6: usize,
            a7: usize,
            a8: usize,
        ) callconv(.c) usize {
            return callNode8(symbol, a1, a2, a3, a4, a5, a6, a7, a8);
        }
    };
}

const forward_symbols = [_][]const u8{
    "napi_add_finalizer",
    "napi_acquire_threadsafe_function",
    "napi_call_function",
    "napi_call_threadsafe_function",
    "napi_close_escapable_handle_scope",
    "napi_close_handle_scope",
    "napi_coerce_to_string",
    "napi_create_array_with_length",
    "napi_create_arraybuffer",
    "napi_create_buffer_copy",
    "napi_create_double",
    "napi_create_error",
    "napi_create_function",
    "napi_create_int32",
    "napi_create_object",
    "napi_create_promise",
    "napi_create_reference",
    "napi_create_string_utf8",
    "napi_create_threadsafe_function",
    "napi_create_type_error",
    "napi_create_typedarray",
    "napi_create_uint32",
    "napi_define_class",
    "napi_define_properties",
    "napi_delete_reference",
    "napi_escape_handle",
    "napi_fatal_error",
    "napi_get_and_clear_last_exception",
    "napi_get_array_length",
    "napi_get_boolean",
    "napi_get_cb_info",
    "napi_get_element",
    "napi_get_global",
    "napi_get_last_error_info",
    "napi_get_named_property",
    "napi_get_new_target",
    "napi_get_null",
    "napi_get_property",
    "napi_get_reference_value",
    "napi_get_threadsafe_function_context",
    "napi_get_typedarray_info",
    "napi_get_undefined",
    "napi_get_uv_event_loop",
    "napi_get_value_bool",
    "napi_get_value_double",
    "napi_get_value_int32",
    "napi_get_value_string_utf8",
    "napi_get_value_uint32",
    "napi_has_property",
    "napi_is_exception_pending",
    "napi_module_register",
    "napi_new_instance",
    "napi_open_escapable_handle_scope",
    "napi_open_handle_scope",
    "napi_ref_threadsafe_function",
    "napi_release_threadsafe_function",
    "napi_resolve_deferred",
    "napi_run_script",
    "napi_set_element",
    "napi_set_named_property",
    "napi_set_property",
    "napi_throw",
    "napi_throw_error",
    "napi_typeof",
    "napi_unwrap",
    "napi_unref_threadsafe_function",
    "napi_wrap",
    "uv_accept",
    "uv_async_init",
    "uv_async_send",
    "uv_buf_init",
    "uv_cancel",
    "uv_close",
    "uv_err_name",
    "uv_fileno",
    "uv_freeaddrinfo",
    "uv_getaddrinfo",
    "uv_handle_get_data",
    "uv_handle_set_data",
    "uv_hrtime",
    "uv_ip4_addr",
    "uv_is_closing",
    "uv_is_writable",
    "uv_listen",
    "uv_loop_close",
    "uv_loop_init",
    "uv_mutex_destroy",
    "uv_mutex_init",
    "uv_mutex_lock",
    "uv_mutex_unlock",
    "uv_queue_work",
    "uv_read_start",
    "uv_read_stop",
    "uv_recv_buffer_size",
    "uv_run",
    "uv_send_buffer_size",
    "uv_stop",
    "uv_strerror",
    "uv_tcp_bind",
    "uv_tcp_connect",
    "uv_tcp_getpeername",
    "uv_tcp_getsockname",
    "uv_tcp_init",
    "uv_tcp_init_ex",
    "uv_tcp_keepalive",
    "uv_tcp_nodelay",
    "uv_thread_create",
    "uv_thread_join",
    "uv_thread_self",
    "uv_timer_init",
    "uv_timer_start",
    "uv_timer_stop",
    "uv_udp_bind",
    "uv_udp_getsockname",
    "uv_udp_init",
    "uv_udp_recv_start",
    "uv_udp_recv_stop",
    "uv_udp_send",
    "uv_walk",
    "uv_write",
};

pub export fn qq_magic_napi_register(module: ?*NapiModule, reserved: usize, flags: usize) callconv(.c) void {
    _ = reserved;
    _ = flags;
    const proc = resolveNodeProc("napi_module_register") orelse return;
    const RegisterFn = *const fn (?*NapiModule) callconv(.c) void;
    const register_fn: RegisterFn = @ptrCast(@alignCast(proc));
    register_fn(module);
}

pub export fn qq_magic_node_register(module: ?*NapiModule, reserved: usize, flags: usize) callconv(.c) void {
    qq_magic_napi_register(module, reserved, flags);
}

pub export fn IsEnvironmentStopping(isolate: ?*anyopaque) callconv(.c) bool {
    _ = isolate;
    return false;
}

pub export fn is_environment_stopping_mangled(isolate: ?*anyopaque) callconv(.c) bool {
    return IsEnvironmentStopping(isolate);
}

fn isEnvironmentStoppingDecorated(isolate: ?*anyopaque) callconv(.c) bool {
    return IsEnvironmentStopping(isolate);
}

fn v8IsolateGetCurrentShim() callconv(.c) ?*anyopaque {
    const proc = resolveNodeProc("?GetCurrent@Isolate@v8@@SAPEAV12@XZ") orelse return null;
    const CurrentFn = *const fn () callconv(.c) ?*anyopaque;
    const current_fn: CurrentFn = @ptrCast(@alignCast(proc));
    return current_fn();
}

pub export fn v8_isolate_get_current() callconv(.c) ?*anyopaque {
    return v8IsolateGetCurrentShim();
}

pub export fn get_secondary_loop() callconv(.c) usize {
    return 0;
}

pub export fn pump_secondary_loop() callconv(.c) usize {
    return 0;
}

pub export fn PerfTrace() callconv(.c) usize {
    return 0;
}

pub export fn DllMain(hinst: ?*anyopaque, reason: u32, reserved: ?*anyopaque) callconv(.winapi) i32 {
    _ = hinst;
    _ = reason;
    _ = reserved;
    return 1;
}

comptime {
    @export(&isEnvironmentStoppingDecorated, .{
        .name = "?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z",
        .linkage = .strong,
    });
    @export(&v8IsolateGetCurrentShim, .{
        .name = "?GetCurrent@Isolate@v8@@SAPEAV12@XZ",
        .linkage = .strong,
    });
    for (forward_symbols) |symbol| {
        const ForwardFn = makeForward8(symbol);
        @export(&ForwardFn.call, .{
            .name = symbol,
            .linkage = .strong,
        });
    }
}

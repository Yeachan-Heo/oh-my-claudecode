#!/usr/bin/env python3
"""Gyoshu Python Bridge - JSON-RPC 2.0 over Unix Socket.

This bridge provides a protocol-based interface for executing Python code
from the Scientist agent. Communication happens over Unix socket using
Newline-Delimited JSON (NDJSON) with JSON-RPC 2.0 message format.

Protocol Format (JSON-RPC 2.0):
  Request:  {"jsonrpc": "2.0", "id": "req_001", "method": "execute", "params": {...}}
  Response: {"jsonrpc": "2.0", "id": "req_001", "result": {...}}
  Error:    {"jsonrpc": "2.0", "id": "req_001", "error": {"code": -32600, "message": "..."}}

Methods:
- execute(code, timeout) - Execute Python code in persistent namespace
- interrupt() - Set interrupt flag for running execution
- reset() - Clear execution namespace
- get_state() - Get memory and variable info
- ping() - Health check
"""

import sys
import os
import json
import time
import io
import re
import signal
import contextlib
import traceback
import threading
import gc
import argparse
import socket as socket_module
import stat
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Callable, Tuple

# =============================================================================
# JSON-RPC 2.0 PROTOCOL
# =============================================================================

JSON_RPC_VERSION = "2.0"

# JSON-RPC 2.0 Error Codes
ERROR_PARSE = -32700  # Invalid JSON
ERROR_INVALID_REQUEST = -32600  # Not a valid Request object
ERROR_METHOD_NOT_FOUND = -32601  # Method does not exist
ERROR_INVALID_PARAMS = -32602  # Invalid method parameters
ERROR_INTERNAL = -32603  # Internal JSON-RPC error
ERROR_EXECUTION = -32000  # Application-specific: execution error
ERROR_TIMEOUT = -32001  # Application-specific: timeout

# Global protocol output stream (set per-connection in socket mode)
_protocol_out: Optional[io.TextIOWrapper] = None


def _send_protocol(data: dict) -> None:
    """Write NDJSON message to protocol channel."""
    global _protocol_out
    if _protocol_out:
        _protocol_out.write(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
        )
        _protocol_out.flush()


def send_response(
    id: Optional[str], result: Optional[Dict] = None, error: Optional[Dict] = None
) -> None:
    """Send JSON-RPC 2.0 response via protocol channel."""
    response: Dict[str, Any] = {
        "jsonrpc": JSON_RPC_VERSION,
        "id": id,
    }

    if error is not None:
        response["error"] = error
    else:
        response["result"] = result

    _send_protocol(response)


def make_error(code: int, message: str, data: Optional[Any] = None) -> Dict:
    """Create a JSON-RPC 2.0 error object."""
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return error


# =============================================================================
# MARKER PARSING
# =============================================================================

# Marker pattern for structured output
# Examples:
#   [OBJECTIVE] Loading data...
#   [STAT:mean] 0.95
#   [DATA] Shape: (100, 5)
MARKER_REGEX = re.compile(
    r"^\s*\[([A-Z][A-Z0-9_-]*)(?::([^\]]+))?\]\s*(.*)$", re.MULTILINE
)

# Scientific marker taxonomy
MARKER_CATEGORIES = {
    # Research Process
    "OBJECTIVE": "research_process",
    "HYPOTHESIS": "research_process",
    "EXPERIMENT": "research_process",
    "OBSERVATION": "research_process",
    "ANALYSIS": "research_process",
    "CONCLUSION": "research_process",
    # Data Operations
    "DATA": "data_operations",
    "SHAPE": "data_operations",
    "DTYPE": "data_operations",
    "RANGE": "data_operations",
    "MISSING": "data_operations",
    "MEMORY": "data_operations",
    # Calculations
    "CALC": "calculations",
    "METRIC": "calculations",
    "STAT": "calculations",
    "CORR": "calculations",
    # Artifacts
    "PLOT": "artifacts",
    "ARTIFACT": "artifacts",
    "TABLE": "artifacts",
    "FIGURE": "artifacts",
    # Insights
    "FINDING": "insights",
    "INSIGHT": "insights",
    "PATTERN": "insights",
    # Workflow
    "STEP": "workflow",
    "STAGE": "workflow",
    "CHECKPOINT": "workflow",
    "CHECK": "workflow",
    "INFO": "workflow",
    "WARNING": "workflow",
    "ERROR": "workflow",
    "DEBUG": "workflow",
    # Scientific
    "CITATION": "scientific",
    "LIMITATION": "scientific",
    "NEXT_STEP": "scientific",
    "DECISION": "scientific",
}


def parse_markers(text: str) -> List[Dict[str, Any]]:
    """Extract markers from output text.

    Args:
        text: Raw output text potentially containing markers

    Returns:
        List of marker dicts with type, subtype, content, line_number, category, valid
    """
    markers = []

    for match in MARKER_REGEX.finditer(text):
        raw_type = match.group(1)
        marker_type = raw_type.replace("-", "_")
        subtype_str = match.group(2)  # May be None
        content = match.group(3).strip()

        # Calculate line number (1-indexed)
        line_number = text[: match.start()].count("\n") + 1

        # Classify marker and check validity
        category = MARKER_CATEGORIES.get(marker_type, "unknown")
        valid = marker_type in MARKER_CATEGORIES

        markers.append(
            {
                "type": marker_type,
                "subtype": subtype_str,
                "content": content,
                "line_number": line_number,
                "category": category,
                "valid": valid,
            }
        )

    return markers


# =============================================================================
# BOUNDED STRING IO
# =============================================================================

MAX_CAPTURE_CHARS = 1048576  # 1MB default


class BoundedStringIO:
    """StringIO wrapper that caps capture size to prevent memory exhaustion."""

    def __init__(self, max_size: int = MAX_CAPTURE_CHARS):
        self._buffer: List[str] = []
        self._size = 0
        self._max_size = max_size
        self._truncated = False

    def write(self, s: str) -> int:
        if self._truncated:
            return len(s)
        new_size = self._size + len(s)
        if new_size > self._max_size:
            remaining = self._max_size - self._size
            if remaining > 0:
                self._buffer.append(s[:remaining])
            self._truncated = True
        else:
            self._buffer.append(s)
            self._size = new_size
        return len(s)

    def getvalue(self) -> str:
        result = "".join(self._buffer)
        if self._truncated:
            result += "\n[OUTPUT TRUNCATED - exceeded 1MB limit]"
        return result

    @property
    def truncated(self) -> bool:
        return self._truncated

    def flush(self) -> None:
        """No-op for compatibility with sys.stdout interface."""
        pass


# =============================================================================
# MEMORY UTILITIES
# =============================================================================


def get_memory_usage() -> Dict[str, float]:
    """Get current process memory usage in MB.

    Returns:
        Dict with rss_mb (resident set size) and vms_mb (virtual memory size)
    """
    try:
        import psutil

        process = psutil.Process()
        mem = process.memory_info()
        return {
            "rss_mb": round(mem.rss / (1024 * 1024), 2),
            "vms_mb": round(mem.vms / (1024 * 1024), 2),
        }
    except ImportError:
        # Fallback: use resource module
        try:
            import resource

            usage = resource.getrusage(resource.RUSAGE_SELF)
            # maxrss is in KB on Linux, bytes on macOS
            rss_kb = usage.ru_maxrss
            if sys.platform == "darwin":
                rss_kb = rss_kb / 1024  # Convert bytes to KB on macOS
            return {
                "rss_mb": round(rss_kb / 1024, 2),
                "vms_mb": 0.0,  # Not available via resource
            }
        except ImportError:
            # Final fallback: read from /proc on Linux
            try:
                with open(f"/proc/{os.getpid()}/status", "r") as f:
                    status = f.read()

                rss = 0.0
                vms = 0.0
                for line in status.split("\n"):
                    if line.startswith("VmRSS:"):
                        rss = int(line.split()[1]) / 1024  # kB to MB
                    elif line.startswith("VmSize:"):
                        vms = int(line.split()[1]) / 1024

                return {"rss_mb": round(rss, 2), "vms_mb": round(vms, 2)}
            except Exception:
                return {"rss_mb": 0.0, "vms_mb": 0.0}


def clean_memory() -> Dict[str, float]:
    """Run garbage collection and return memory after cleanup."""
    gc.collect()
    return get_memory_usage()


# =============================================================================
# EXECUTION STATE
# =============================================================================


class ExecutionState:
    """Manages persistent execution namespace and interrupt handling."""

    def __init__(self):
        self._namespace: Dict[str, Any] = {}
        self._interrupt_flag = threading.Event()
        self._execution_lock = threading.Lock()

        # Initialize with common imports available
        self._initialize_namespace()

    def _initialize_namespace(self):
        """Set up default namespace with helper functions."""
        self._namespace = {
            "__name__": "__gyoshu__",
            "__doc__": "Gyoshu execution namespace",
            # Provide helper functions
            "clean_memory": clean_memory,
            "get_memory": get_memory_usage,
        }

    def reset(self) -> Dict[str, Any]:
        """Clear namespace and reset state."""
        with self._execution_lock:
            self._namespace.clear()
            self._initialize_namespace()
            self._interrupt_flag.clear()
            gc.collect()

        return {
            "status": "reset",
            "memory": get_memory_usage(),
        }

    def get_state(self) -> Dict[str, Any]:
        """Return current state information."""
        # Get user-defined variables (exclude dunder and builtins)
        user_vars = [
            k
            for k in self._namespace.keys()
            if not k.startswith("_") and k not in ("clean_memory", "get_memory")
        ]

        return {
            "memory": get_memory_usage(),
            "variables": user_vars,
            "variable_count": len(user_vars),
        }

    def interrupt(self) -> Dict[str, Any]:
        """Set interrupt flag to stop execution."""
        self._interrupt_flag.set()
        return {"status": "interrupt_requested"}

    @property
    def namespace(self) -> Dict[str, Any]:
        return self._namespace

    @property
    def interrupt_flag(self) -> threading.Event:
        return self._interrupt_flag


# Global execution state
_state = ExecutionState()


# =============================================================================
# CODE EXECUTION
# =============================================================================


class ExecutionTimeoutError(Exception):
    """Raised when code execution exceeds timeout."""

    pass


def _timeout_handler(signum, frame):
    """Signal handler for execution timeout."""
    raise ExecutionTimeoutError("Code execution timed out")


def execute_code(
    code: str,
    namespace: Dict[str, Any],
    timeout: Optional[float] = None,
    interrupt_flag: Optional[threading.Event] = None,
) -> Dict[str, Any]:
    """Execute Python code and capture output.

    Args:
        code: Python code to execute
        namespace: Execution namespace (modified in place)
        timeout: Maximum execution time in seconds (None = no limit)
        interrupt_flag: Event to check for interrupt requests

    Returns:
        Dict with success, stdout, stderr, exception info
    """
    stdout_capture = BoundedStringIO()
    stderr_capture = BoundedStringIO()

    result = {
        "success": False,
        "stdout": "",
        "stderr": "",
        "stdout_truncated": False,
        "stderr_truncated": False,
        "exception": None,
        "exception_type": None,
        "traceback": None,
    }

    # Set up timeout (Unix only - uses SIGALRM)
    old_handler = None
    if timeout and hasattr(signal, "SIGALRM"):
        old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(int(timeout))

    try:
        # Redirect stdout/stderr for user code
        with contextlib.redirect_stdout(stdout_capture), contextlib.redirect_stderr(
            stderr_capture
        ):
            # Compile code for better error messages
            compiled = compile(code, "<gyoshu>", "exec")

            # Execute in provided namespace
            exec(compiled, namespace)

        result["success"] = True

    except ExecutionTimeoutError as e:
        result["exception"] = str(e)
        result["exception_type"] = "TimeoutError"
        result["traceback"] = "Execution timed out"

    except KeyboardInterrupt:
        result["exception"] = "Execution interrupted"
        result["exception_type"] = "KeyboardInterrupt"
        result["traceback"] = "Interrupted by user"

    except SyntaxError as e:
        result["exception"] = str(e)
        result["exception_type"] = "SyntaxError"
        result["traceback"] = "".join(
            traceback.format_exception(type(e), e, e.__traceback__)
        )

    except Exception as e:
        result["exception"] = str(e)
        result["exception_type"] = type(e).__name__
        result["traceback"] = "".join(
            traceback.format_exception(type(e), e, e.__traceback__)
        )

    finally:
        if timeout and hasattr(signal, "SIGALRM"):
            signal.alarm(0)
            if old_handler is not None:
                signal.signal(signal.SIGALRM, old_handler)

        result["stdout"] = stdout_capture.getvalue()
        result["stderr"] = stderr_capture.getvalue()
        result["stdout_truncated"] = stdout_capture.truncated
        result["stderr_truncated"] = stderr_capture.truncated

    return result


# =============================================================================
# REQUEST HANDLERS
# =============================================================================


def handle_execute(id: str, params: Dict[str, Any]) -> None:
    """Handle 'execute' method - run Python code.

    Params:
        code (str): Python code to execute
        timeout (float, optional): Timeout in seconds (default: 300)
    """
    code = params.get("code")
    if not code:
        send_response(
            id,
            error=make_error(ERROR_INVALID_PARAMS, "Missing required parameter: code"),
        )
        return

    if not isinstance(code, str):
        send_response(
            id,
            error=make_error(ERROR_INVALID_PARAMS, "Parameter 'code' must be a string"),
        )
        return

    timeout = params.get("timeout", 300)  # Default 5 minutes
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        timeout = 300

    # Clear interrupt flag before execution
    _state.interrupt_flag.clear()

    # Record start time
    start_time = time.time()
    started_at = datetime.now(timezone.utc).isoformat()

    # Execute the code
    exec_result = execute_code(
        code=code,
        namespace=_state.namespace,
        timeout=timeout,
        interrupt_flag=_state.interrupt_flag,
    )

    # Calculate duration
    duration_ms = round((time.time() - start_time) * 1000, 2)

    # Parse markers from stdout
    markers = parse_markers(exec_result["stdout"])

    # Build response
    response = {
        "success": exec_result["success"],
        "stdout": exec_result["stdout"],
        "stderr": exec_result["stderr"],
        "stdout_truncated": exec_result.get("stdout_truncated", False),
        "stderr_truncated": exec_result.get("stderr_truncated", False),
        "markers": markers,
        "timing": {
            "started_at": started_at,
            "duration_ms": duration_ms,
        },
        "memory": get_memory_usage(),
    }

    # Add error info if failed
    if not exec_result["success"]:
        response["error"] = {
            "type": exec_result["exception_type"],
            "message": exec_result["exception"],
            "traceback": exec_result["traceback"],
        }

    send_response(id, result=response)


def handle_interrupt(id: str, params: Dict[str, Any]) -> None:
    """Handle 'interrupt' method - signal interrupt to running code."""
    result = _state.interrupt()
    send_response(id, result=result)


def handle_reset(id: str, params: Dict[str, Any]) -> None:
    """Handle 'reset' method - clear namespace and state."""
    result = _state.reset()
    send_response(id, result=result)


def handle_get_state(id: str, params: Dict[str, Any]) -> None:
    """Handle 'get_state' method - return current state info."""
    result = _state.get_state()
    send_response(id, result=result)


def handle_ping(id: str, params: Dict[str, Any]) -> None:
    """Handle 'ping' method - health check."""
    send_response(
        id,
        result={
            "status": "ok",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )


# Method registry
HANDLERS: Dict[str, Callable[[str, Dict[str, Any]], None]] = {
    "execute": handle_execute,
    "interrupt": handle_interrupt,
    "reset": handle_reset,
    "get_state": handle_get_state,
    "ping": handle_ping,
}


# =============================================================================
# REQUEST PROCESSING
# =============================================================================

# Cap JSON-RPC request line size to prevent DoS (10MB)
MAX_REQUEST_LINE_BYTES = 10 * 1024 * 1024


def read_bounded_line(stream, max_bytes: int) -> Tuple[Optional[bytes], bool]:
    """Read a line with bounded byte count.

    Returns:
        Tuple of (line_bytes or None if EOF, was_oversized)
        - If EOF with no data: (None, False)
        - If line fits in limit: (bytes, False)
        - If line exceeded limit: (truncated_bytes, True)
    """
    data = bytearray()
    while len(data) < max_bytes:
        char = stream.read(1)
        if not char:
            # EOF - return what we have
            return (bytes(data) if data else None, False)
        if char == b"\n":
            # Normal line termination
            return (bytes(data), False)
        data.extend(char)

    # Limit exceeded - drain rest of line
    while True:
        char = stream.read(1)
        if not char or char == b"\n":
            break
    return (bytes(data[:max_bytes]), True)


def process_request(line: str) -> None:
    """Parse and handle a single JSON-RPC request."""
    request_id: Optional[str] = None

    try:
        # Parse JSON
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            send_response(None, error=make_error(ERROR_PARSE, f"Parse error: {e}"))
            return

        # Validate request structure
        if not isinstance(request, dict):
            send_response(
                None,
                error=make_error(
                    ERROR_INVALID_REQUEST, "Request must be a JSON object"
                ),
            )
            return

        # Extract id (may be null for notifications, but we require it)
        request_id = request.get("id")

        # Check jsonrpc version
        if request.get("jsonrpc") != JSON_RPC_VERSION:
            send_response(
                request_id,
                error=make_error(
                    ERROR_INVALID_REQUEST,
                    f"Invalid jsonrpc version, expected '{JSON_RPC_VERSION}'",
                ),
            )
            return

        # Extract method
        method = request.get("method")
        if not method or not isinstance(method, str):
            send_response(
                request_id,
                error=make_error(ERROR_INVALID_REQUEST, "Missing or invalid 'method'"),
            )
            return

        # Extract params (optional, default to empty dict)
        params = request.get("params", {})
        if not isinstance(params, dict):
            send_response(
                request_id,
                error=make_error(
                    ERROR_INVALID_PARAMS, "Parameter 'params' must be an object"
                ),
            )
            return

        # Find handler
        handler = HANDLERS.get(method)
        if not handler:
            send_response(
                request_id,
                error=make_error(ERROR_METHOD_NOT_FOUND, f"Method not found: {method}"),
            )
            return

        # Execute handler
        handler(request_id, params)

    except Exception as e:
        # Catch-all for unexpected errors
        send_response(
            request_id,
            error=make_error(
                ERROR_INTERNAL, f"Internal error: {e}", data=traceback.format_exc()
            ),
        )


# =============================================================================
# SOCKET SERVER
# =============================================================================


def safe_unlink_socket(socket_path: str) -> None:
    """Safely unlink a socket file, handling races and verifying type."""
    try:
        st = os.lstat(socket_path)
        if stat.S_ISSOCK(st.st_mode):
            os.unlink(socket_path)
    except FileNotFoundError:
        pass  # Already removed
    except OSError:
        pass  # Best effort


def run_socket_server(socket_path: str) -> None:
    """Run the JSON-RPC server over Unix socket."""
    global _protocol_out

    # Safely remove existing socket
    safe_unlink_socket(socket_path)

    server = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)

    # Set umask to ensure socket mode 0600 (owner only)
    old_umask = os.umask(0o177)
    try:
        server.bind(socket_path)

        # Post-bind verification: ensure socket has expected ownership and mode
        try:
            st = os.lstat(socket_path)
            if not stat.S_ISSOCK(st.st_mode):
                raise RuntimeError(
                    f"Post-bind check failed: {socket_path} is not a socket"
                )
            if st.st_uid != os.getuid():
                raise RuntimeError(
                    f"Post-bind check failed: {socket_path} not owned by us"
                )
            mode = st.st_mode & 0o777
            if mode != 0o600:
                raise RuntimeError(
                    f"Post-bind check failed: {socket_path} has mode {oct(mode)}, expected 0o600"
                )
        except Exception:
            server.close()
            raise
    finally:
        os.umask(old_umask)

    server.listen(1)

    print(
        f"[gyoshu_bridge] Socket server started at {socket_path}, PID={os.getpid()}",
        file=sys.stderr,
    )
    sys.stderr.flush()

    def shutdown_handler(signum, frame):
        print("[gyoshu_bridge] Shutdown signal received", file=sys.stderr)
        sys.stderr.flush()
        server.close()
        safe_unlink_socket(socket_path)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    try:
        while True:
            conn, addr = server.accept()
            handle_socket_connection(conn)
    except Exception as e:
        print(f"[gyoshu_bridge] Server error: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    finally:
        server.close()
        safe_unlink_socket(socket_path)


def handle_socket_connection(conn: socket_module.socket) -> None:
    """Handle a single client connection."""
    global _protocol_out

    try:
        _protocol_out = conn.makefile("w", buffering=1, encoding="utf-8")

        reader = conn.makefile("rb")
        while True:
            line_bytes, was_oversized = read_bounded_line(
                reader, MAX_REQUEST_LINE_BYTES
            )
            if line_bytes is None:
                break
            if was_oversized:
                send_response(
                    None, error=make_error(ERROR_INVALID_REQUEST, "Request too large")
                )
                continue
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            process_request(line)
    except Exception as e:
        print(f"[gyoshu_bridge] Connection error: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    finally:
        try:
            conn.close()
        except Exception:
            pass


# =============================================================================
# MAIN
# =============================================================================


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Gyoshu Python Bridge - JSON-RPC 2.0 over Unix Socket"
    )
    parser.add_argument(
        "socket_path",
        nargs="?",
        help="Unix socket path (required)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if not args.socket_path:
        print("Usage: gyoshu_bridge.py <socket_path>", file=sys.stderr)
        print("Example: gyoshu_bridge.py /tmp/gyoshu.sock", file=sys.stderr)
        sys.exit(1)

    run_socket_server(args.socket_path)


if __name__ == "__main__":
    main()

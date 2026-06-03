#!/usr/bin/env python3
"""
Codex-compatible CLI wrapper for oh-my-claudecode.

Supported modes:
- `codex --version`
- `codex exec ... [PROMPT]`
- interactive `codex [--model ...]` worker mode for tmux/team panes

The wrapper can talk either to a Venus/OpenAI-compatible relay (recommended)
or directly to Venus LLMProxy.
"""

import argparse
import json
import os
import sys
from typing import Any

import requests

DEFAULT_VENUS_SECRET_ID = ""
DEFAULT_VENUS_GROUP = ""
DEFAULT_VENUS_URL = "http://v2.open.venus.oa.com/llmproxy/chat/completions"
DEFAULT_OPENAI_COMPAT_BASE_URL = "http://127.0.0.1:18810/v1"
DEFAULT_MODEL = "gpt-5.5"
WRAPPER_VERSION = "venus-codex-wrapper 0.2.0"
GPT_FAMILY_PREFIXES = ("gpt-",)
INTERACTIVE_BANNER = "Venus Codex interactive mode ready. Send a prompt line to execute."


def stdout_print(message: str = "") -> None:
    print(message, flush=True)


def stderr_print(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def get_default_model() -> str:
    return (
        os.environ.get("OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL")
        or os.environ.get("OMC_CODEX_DEFAULT_MODEL")
        or os.environ.get("VENUS_CODEX_MODEL")
        or DEFAULT_MODEL
    )


def build_parser():
    parser = argparse.ArgumentParser(prog="codex", add_help=True)
    parser.add_argument("--version", action="store_true")
    parser.add_argument("-m", "--model", default=get_default_model())
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--dangerously-bypass-approvals-and-sandbox", action="store_true")
    parser.add_argument("--skip-git-repo-check", action="store_true")
    parser.add_argument("extra", nargs="*")

    subparsers = parser.add_subparsers(dest="command")
    exec_parser = subparsers.add_parser("exec")
    exec_parser.add_argument("-m", "--model", default=get_default_model())
    exec_parser.add_argument("--json", action="store_true")
    exec_parser.add_argument("--dangerously-bypass-approvals-and-sandbox", action="store_true")
    exec_parser.add_argument("--skip-git-repo-check", action="store_true")
    exec_parser.add_argument("extra", nargs="*")

    return parser


def venus_token() -> str:
    explicit = os.environ.get("VENUS_API_TOKEN")
    if explicit:
        return explicit

    secret_id = os.environ.get("ENV_VENUS_OPENAPI_SECRET_ID", DEFAULT_VENUS_SECRET_ID).strip()
    group = os.environ.get("VENUS_GROUP", DEFAULT_VENUS_GROUP).strip()
    if secret_id and group:
        return f"{secret_id}@{group}"

    return ""


def get_openai_base_url() -> str | None:
    base_url = (
        os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("VENUS_OPENAI_BASE_URL")
        or os.environ.get("CHAT_SERVICE_BASE_URL")
        or DEFAULT_OPENAI_COMPAT_BASE_URL
    ).strip()
    return base_url.rstrip("/") if base_url else None


def build_openai_url(base_url: str) -> str:
    if base_url.endswith("/chat/completions"):
        return base_url
    if base_url.endswith("/v1"):
        return f"{base_url}/chat/completions"
    return f"{base_url}/v1/chat/completions"


def get_openai_api_key() -> str:
    return (
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("CHAT_SERVICE_API_KEY")
        or os.environ.get("VENUS_OPENAI_API_KEY")
        or ""
    ).strip()


def create_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    session.proxies = {"http": None, "https": None}
    return session


def build_body(model: str, prompt: str) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }

    if not model.startswith(GPT_FAMILY_PREFIXES):
        body["max_tokens"] = int(os.environ.get("VENUS_MAX_TOKENS", "4096"))
        temperature = os.environ.get("VENUS_TEMPERATURE")
        if temperature is not None:
            body["temperature"] = float(temperature)

    return body


def call_openai_compat(model: str, prompt: str) -> dict[str, Any]:
    base_url = get_openai_base_url()
    if not base_url:
        raise RuntimeError("OPENAI_BASE_URL is not configured")

    api_key = get_openai_api_key()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required when using OPENAI_BASE_URL")

    response = create_session().post(
        build_openai_url(base_url),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=build_body(model, prompt),
        timeout=int(os.environ.get("VENUS_TIMEOUT_SECONDS", "180")),
    )
    if response.status_code != 200:
        raise RuntimeError(f"OpenAI-compatible HTTP {response.status_code}: {response.text[:1000]}")
    return response.json()


def call_venus_direct(model: str, prompt: str) -> dict[str, Any]:
    token = venus_token()
    if not token:
        raise RuntimeError(
            "Venus direct mode requires VENUS_API_TOKEN or ENV_VENUS_OPENAPI_SECRET_ID + VENUS_GROUP"
        )

    response = create_session().post(
        os.environ.get("VENUS_LLMPROXY_URL", DEFAULT_VENUS_URL),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=build_body(model, prompt),
        timeout=int(os.environ.get("VENUS_TIMEOUT_SECONDS", "180")),
    )
    if response.status_code != 200:
        raise RuntimeError(f"Venus HTTP {response.status_code}: {response.text[:1000]}")
    return response.json()


def call_venus(model: str, prompt: str) -> dict[str, Any]:
    if os.environ.get("OPENAI_API_KEY") or os.environ.get("CHAT_SERVICE_API_KEY") or os.environ.get("VENUS_OPENAI_API_KEY"):
        return call_openai_compat(model, prompt)
    return call_venus_direct(model, prompt)


def extract_text(data: dict[str, Any]) -> str:
    message = data.get("choices", [{}])[0].get("message", {})
    content = message.get("content") or message.get("reasoning_content") or ""
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts).strip()
    return str(content).strip()


def emit_exec_output(text: str, as_jsonl: bool) -> None:
    if as_jsonl:
        stdout_print(json.dumps({"type": "message", "role": "assistant", "content": text}, ensure_ascii=False))
        return
    stdout_print(text)


def resolve_exec_prompt(extra: list[str]) -> str:
    if extra:
        if extra == ["-"]:
            return sys.stdin.read().strip()
        return " ".join(extra).strip()
    return sys.stdin.read().strip()


def run_exec(model: str, extra: list[str], as_jsonl: bool) -> int:
    prompt = resolve_exec_prompt(extra)
    if not prompt:
        stderr_print("empty prompt")
        return 2

    try:
        data = call_venus(model, prompt)
        emit_exec_output(extract_text(data), as_jsonl)
        return 0
    except Exception as exc:
        stderr_print(str(exc))
        return 1


def run_interactive(model: str) -> int:
    stdout_print(INTERACTIVE_BANNER)
    while True:
        line = sys.stdin.readline()
        if line == "":
            return 0

        prompt = line.strip()
        if not prompt:
            continue
        if prompt.lower() in {"exit", "quit", ":q"}:
            return 0

        try:
            data = call_venus(model, prompt)
            text = extract_text(data)
            stdout_print(text if text else "(empty response)")
        except KeyboardInterrupt:
            return 130
        except Exception as exc:
            stderr_print(str(exc))


def main() -> int:
    parser = build_parser()
    args, _unknown = parser.parse_known_args()

    if getattr(args, "version", False):
        stdout_print(WRAPPER_VERSION)
        return 0

    if args.command == "exec":
        return run_exec(args.model, list(args.extra), bool(args.json))

    if args.command is None:
        return run_interactive(args.model)

    stderr_print("unsupported command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

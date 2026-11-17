"""Launch the Windows renderer companion from the active Ubuntu sidecar.

Host credentials remain in environment/memory; they are never written or logged.
Windows can reach WSL's language server and its own loopback CDP endpoint.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request


def windows_path(value, distro):
    if not value.startswith('/'):
        return value
    mounted = re.match(r'^/mnt/([a-z])/(.*)$', value, re.I)
    if mounted:
        return mounted[1].upper() + ':\\' + mounted[2].replace('/', '\\')
    return '\\\\wsl.localhost\\' + distro + value.replace('/', '\\')


def linux_executable(value):
    drive = re.match(r'^([a-z]):[\\/](.*)$', value, re.I)
    if not drive:
        raise RuntimeError('Windows Node executable must use a drive path')
    return '/mnt/' + drive[1].lower() + '/' + drive[2].replace('\\', '/')


def discover_language_server():
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().decode().split('\0')
        except (OSError, UnicodeError):
            continue
        if 'language_server' not in args[0] or '--standalone' not in args:
            continue
        match = re.search(r'--csrf_token(?:=|\s+)"?([^\s"]+)', ' '.join(args))
        if not match:
            continue
        try:
            listing = subprocess.check_output(['lsof', '-nP', '-a', '-p', entry.name, '-iTCP', '-sTCP:LISTEN', '-Fn'], text=True, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            continue
        for port in set(re.findall(r':(\d+)\s*$', listing, re.M)):
            try:
                req = urllib.request.Request('http://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/GetStatus', data=b'{}', headers={'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': match[1]})
                with urllib.request.urlopen(req, timeout=2) as response:
                    response.read()
                return '127.0.0.1:' + port, match[1]
            except Exception:
                pass
    return None


def main():
    env = dict(os.environ)
    distro = env.get('WSL_DISTRO_NAME', 'Ubuntu')
    if len(sys.argv) > 1 and sys.argv[1] == '--install':
        node, entry = sys.argv[2:4]
        extra = sys.argv[4:]
        env['ANTIGRAVITY_GEMINI_DIR'] = str(Path.home() / '.gemini')
        endpoint = discover_language_server()
        if endpoint:
            env['ANTIGRAVITY_LS_ADDRESS'], env['ANTIGRAVITY_CSRF_TOKEN'] = endpoint
    else:
        config = json.loads(Path(__file__).with_name('windows-bridge.json').read_text())
        node, entry, distro = config['node'], config['entry'], config['distro']
        extra = []
    env['HAGEMI_ACTIVE_WSL_DISTRO'] = distro
    env['HAGEMI_WINDOWS_NODE'] = node
    for name in ('ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_APP_DATA_DIR', 'ANTIGRAVITY_EXECUTABLE_DATA_DIR'):
        if env.get(name):
            env[name] = windows_path(env[name], distro)
    shared = ['ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_APP_DATA_DIR', 'ANTIGRAVITY_EXECUTABLE_DATA_DIR', 'ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_CSRF_TOKEN', 'HAGEMI_ACTIVE_WSL_DISTRO', 'HAGEMI_WINDOWS_NODE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']
    env['WSLENV'] = ':'.join(filter(None, [env.get('WSLENV', ''), *[name for name in shared if name in env]]))
    os.execvpe(linux_executable(node), [node, entry, *extra], env)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Minimal localhost TCP forwarder for opencode-sandbox.

Listens on <bind_ip>:<bind_port> (a docker bridge gateway address, reachable
only from containers on that bridge and from the host itself) and forwards
every connection to <target_host>:<target_port> (the host's localhost-only
model backend).

Stdlib only. No config, no shell, runs with all capabilities dropped.

Usage: forward.py <bind_ip> <bind_port> <target_host> <target_port>
"""
import socket
import sys
import threading


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock, how in ((src, socket.SHUT_RD), (dst, socket.SHUT_WR)):
            try:
                sock.shutdown(how)
            except OSError:
                pass


def handle(client, target):
    try:
        upstream = socket.create_connection(target, timeout=10)
    except OSError:
        client.close()
        return
    relay = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
    relay.start()
    pipe(client, upstream)
    relay.join()
    client.close()
    upstream.close()


def main():
    bind_ip, bind_port, target_host, target_port = (
        sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]))
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((bind_ip, bind_port))
    srv.listen(128)
    print("forwarding %s:%d -> %s:%d" % (bind_ip, bind_port,
                                         target_host, target_port), flush=True)
    while True:
        client, _ = srv.accept()
        threading.Thread(target=handle,
                         args=(client, (target_host, target_port)),
                         daemon=True).start()


if __name__ == "__main__":
    main()

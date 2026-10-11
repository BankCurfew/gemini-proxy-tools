#!/usr/bin/env python3
"""T2890: send ONE proxy command and wait for the reply that counts.

Several proxy copies share the broker. A copy that does not hold the tab answers at once with an error
("No tab with id …"), and an old copy (no `instance` field, one reply per leaked MQTT client) can send many.
`mosquitto_sub -C N` counted those and stopped before the instance holding the tab answered. This reads every
reply for THIS id until one has no error, or the timeout; then it prints that reply (or the last error, or {}).

  python3 scripts/mqtt-call.py --timeout 6 --need answer '<command json with "id">'
    --need KEY   only a reply carrying KEY counts as the answer (e.g. get_response → answer)
Exit 0 = an ok reply · 1 = only errors · 2 = no reply for this id
"""
import argparse, json, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument('--timeout', type=float, default=6)
ap.add_argument('--need', default='')
ap.add_argument('command')
a = ap.parse_args()
cmd = json.loads(a.command)
cid = cmd['id']
cmd.setdefault('ts', int(time.time() * 1000))

sub = subprocess.Popen(['mosquitto_sub', '-t', 'claude/browser/response', '-W', str(int(a.timeout) + 1)],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
time.sleep(0.5)   # subscribed before the command goes out
subprocess.run(['mosquitto_pub', '-t', 'claude/browser/command', '-m', json.dumps(cmd)], check=False)

deadline, last_err = time.time() + a.timeout, None
try:
    for line in sub.stdout:
        try: d = json.loads(line)
        except Exception: continue
        if d.get('id') != cid: continue
        if d.get('error'): last_err = d
        elif not a.need or d.get(a.need): print(json.dumps(d)); sys.exit(0)
        if time.time() > deadline: break
finally:
    sub.kill()
print(json.dumps(last_err or {}))
sys.exit(1 if last_err else 2)

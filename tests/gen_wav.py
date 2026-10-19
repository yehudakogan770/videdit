#!/usr/bin/env python3
"""Write a test WAV where every second holds one constant sample value.

Second s has value (s % 1000) * 30 - 15000 on both channels, so an export can be
checked sample-exactly: the value at any point tells which source second it came from.
Usage: python3 tests/gen_wav.py out.wav SECONDS [rf64]
  rf64: write an RF64 header (for >4 GB files).
"""
import struct
import sys


def val(sec):
    return (sec % 1000) * 30 - 15000


def gen(path, seconds, rf64=False):
    rate, ch = 44100, 2
    data = seconds * rate * ch * 2
    with open(path, 'wb') as f:
        if rf64:
            f.write(b'RF64' + struct.pack('<I', 0xFFFFFFFF) + b'WAVE')
            f.write(b'ds64' + struct.pack('<IQQQI', 28, data + 36 + 36, data, seconds * rate, 0))
        else:
            f.write(b'RIFF' + struct.pack('<I', 36 + data) + b'WAVE')
        f.write(b'fmt ' + struct.pack('<IHHIIHH', 16, 1, ch, rate, rate * ch * 2, ch * 2, 16))
        f.write(b'data' + struct.pack('<I', 0xFFFFFFFF if rf64 else data))
        for s in range(seconds):
            f.write(struct.pack('<hh', val(s), val(s)) * rate)


if __name__ == '__main__':
    gen(sys.argv[1], int(sys.argv[2]), len(sys.argv) > 3 and sys.argv[3] == 'rf64')

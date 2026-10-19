import struct, sys
def val(sec): return (sec % 1000) * 30 - 15000
def gen(path, seconds, rf64):
    rate, ch = 44100, 2
    data = seconds * rate * ch * 2
    with open(path, 'wb') as f:
        if rf64:
            f.write(b'RF64' + struct.pack('<I', 0xFFFFFFFF) + b'WAVE')
            f.write(b'ds64' + struct.pack('<IQQQI', 28, data + 36 + 36, data, seconds*rate, 0))
        else:
            f.write(b'RIFF' + struct.pack('<I', 36 + data) + b'WAVE')
        f.write(b'fmt ' + struct.pack('<IHHIIHH', 16, 1, ch, rate, rate*ch*2, ch*2, 16))
        f.write(b'data' + struct.pack('<I', 0xFFFFFFFF if rf64 else data))
        for s in range(seconds):
            f.write(struct.pack('<hh', val(s), val(s)) * rate)
gen(sys.argv[1], int(sys.argv[2]), sys.argv[3] == '1')

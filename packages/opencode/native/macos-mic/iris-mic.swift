// iris-mic — records the microphone and writes 16 kHz mono signed 16-bit PCM to stdout.
//
// Why this exists (#189828): ffmpeg's avfoundation input labels a stream with the device's
// NOMINAL rate (96 kHz on a Mac whose Audio MIDI Setup says so) while the hardware delivers its
// real one (44.1 kHz). Resampling "from 96 kHz" then plays speech ~2.2x too fast, and cloud engines
// answer with fluent, wrong sentences. CoreAudio reports the real format, so this reads it.
//
// It is also the only place that decides WHICH input to record. The system default is often an
// aggregate or virtual device (loopback, remote-desktop mics); those carry other people's audio.
//
//   iris-mic                       record from the best input until SIGINT/SIGTERM
//   iris-mic --device "<name>"     a named input (case-insensitive substring)
//   iris-mic --seconds 6           stop by itself (tests)
//   iris-mic --list                one JSON line per input, then exit
//
// stdout: raw PCM only. stderr: one JSON line "start", one JSON line "stop" with frames/wall.
import AVFoundation
import CoreAudio
import Foundation

struct Input { let id: AudioDeviceID; let name: String; let transport: UInt32; let channels: Int }

func fourcc(_ s: String) -> UInt32 { s.utf8.reduce(0) { ($0 << 8) | UInt32($1) } }
let realTransports: Set<UInt32> = ["bltn", "usb ", "blue", "blea", "thun", "1394"].map(fourcc).reduce(into: Set<UInt32>()) { $0.insert($1) }

func address(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func inputs() -> [Input] {
  var addr = address(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
  return ids.compactMap { id in
    var cfg = address(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput)
    var csize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &cfg, 0, nil, &csize) == noErr, csize > 0 else { return nil }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(csize), alignment: 16)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &cfg, 0, nil, &csize, raw) == noErr else { return nil }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    let ch = list.reduce(0) { $0 + Int($1.mNumberChannels) }
    guard ch > 0 else { return nil }
    var nameAddr = address(kAudioObjectPropertyName)
    var name: Unmanaged<CFString>?
    var nsize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nsize, &name)
    var tAddr = address(kAudioDevicePropertyTransportType)
    var transport: UInt32 = 0
    var tsize = UInt32(MemoryLayout<UInt32>.size)
    AudioObjectGetPropertyData(id, &tAddr, 0, nil, &tsize, &transport)
    return Input(id: id, name: (name?.takeRetainedValue() as String?) ?? "Input \(id)", transport: transport, channels: ch)
  }
}

func systemDefault() -> AudioDeviceID {
  var addr = address(kAudioHardwarePropertyDefaultInputDevice)
  var id: AudioDeviceID = 0
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
  return id
}

func json(_ o: [String: Any]) -> String {
  (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
}
func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }

let all = inputs()
if args.contains("--list") {
  let def = systemDefault()
  for i in all {
    print(json(["name": i.name, "channels": i.channels, "real": realTransports.contains(i.transport), "default": i.id == def]))
  }
  exit(0)
}

// Which input: a named one wins and an unknown name is an error, not a silent fallback (#189532).
// Otherwise the system default, unless it is not a real microphone — then the built-in mic.
var chosen: Input?
var reason = "system default"
if let want = option("--device"), !want.isEmpty {
  chosen = all.first { $0.name.lowercased() == want.lowercased() } ?? all.first { $0.name.lowercased().contains(want.lowercased()) }
  if chosen == nil { err(json(["event": "error", "error": "device-not-found", "device": want])); exit(3) }
  reason = "requested"
} else {
  let def = systemDefault()
  chosen = all.first { $0.id == def }
  if let c = chosen, !realTransports.contains(c.transport) {
    let builtIn = all.first { $0.transport == fourcc("bltn") } ?? all.first { realTransports.contains($0.transport) }
    if let b = builtIn { chosen = b; reason = "system default is not a microphone (\(c.name))" }
  }
}
guard let input = chosen else { err(json(["event": "error", "error": "no-input"])); exit(4) }

let engine = AVAudioEngine()
var devId = input.id
if let unit = engine.inputNode.audioUnit {
  AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &devId, UInt32(MemoryLayout<AudioDeviceID>.size))
}
let hw = engine.inputNode.inputFormat(forBus: 0)
guard hw.sampleRate > 0, hw.channelCount > 0 else { err(json(["event": "error", "error": "no-format", "device": input.name])); exit(5) }

let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: hw.sampleRate, channels: 1, interleaved: false)!
let out = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
let converter = AVAudioConverter(from: mono, to: out)!
let stdout = FileHandle.standardOutput
var signalSources: [DispatchSourceSignal] = []
var inFrames = 0, outBytes = 0
let t0 = Date()

engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: hw) { buf, _ in
  guard let data = buf.floatChannelData else { return }
  let n = Int(buf.frameLength)
  guard n > 0, let m = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buf.frameLength) else { return }
  m.frameLength = buf.frameLength
  // Average the first two channels: a mono mic is itself, a stereo mic is its mix, and a many-channel
  // interface does not dilute the one live mic across sixteen silent channels.
  let used = Int(min(2, hw.channelCount))
  let dst = m.floatChannelData![0]
  for i in 0..<n {
    var s: Float = 0
    for c in 0..<used { s += data[c][i] }
    dst[i] = s / Float(used)
  }
  let cap = AVAudioFrameCount(Double(n) * 16000 / hw.sampleRate) + 64
  guard let o = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return }
  var fed = false
  var e: NSError?
  converter.convert(to: o, error: &e) { _, status in
    if fed { status.pointee = .noDataNow; return nil }
    fed = true; status.pointee = .haveData; return m
  }
  inFrames += n
  guard e == nil, o.frameLength > 0, let ch = o.int16ChannelData else { return }
  let bytes = Int(o.frameLength) * 2
  outBytes += bytes
  stdout.write(Data(bytes: ch[0], count: bytes))
}

func finish(_ code: Int32) -> Never {
  engine.stop()
  let wall = Date().timeIntervalSince(t0)
  err(json(["event": "stop", "wall_s": (wall * 100).rounded() / 100, "audio_s": (Double(inFrames) / hw.sampleRate * 100).rounded() / 100, "out_bytes": outBytes]))
  exit(code)
}

do { try engine.start() } catch { err(json(["event": "error", "error": "start-failed", "detail": "\(error)"])); exit(6) }
err(json(["event": "start", "device": input.name, "reason": reason, "channels": Int(hw.channelCount), "rate": hw.sampleRate]))

for sig in [SIGINT, SIGTERM] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { finish(0) }
  src.resume()
  withExtendedLifetime(src) {}
  signalSources.append(src)
}
if let s = option("--seconds"), let secs = Double(s) {
  DispatchQueue.main.asyncAfter(deadline: .now() + secs) { finish(0) }
}
dispatchMain()

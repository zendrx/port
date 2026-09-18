
---
title: native.cr
tagline: React Native, but for Crystal
date: 2026-09-18
tags: [crystal, mobile, ffi, jni, systems]
repo: https://github.com/slick-lab/native.cr
---
# native.cr
> React Native, but for Crystal. Write mobile apps in Crystal, compiled straight
> to native ARM64 binaries — no JS bridge, no Dart VM, no interpreter.
[View on GitHub →](https://github.com/slick-lab/native.cr)
## What it is
`native.cr` lets you build real mobile apps in pure Crystal. On Android it talks
to the platform through **JNI**; on iOS through **raw FFI into UIKit**. Every
widget you create is a real platform view — `TextView` is a real
`android.view.View`, `UIView` on iOS is the genuine article.
No WebView. No Skia. No rendering layer of its own.
## Why this matters
| | native.cr | React Native | Flutter |
|---|---|---|---|
| **Language** | Crystal | JS/TS | Dart |
| **Runtime** | **None** (compiled) | JSC/Hermes | Dart VM/AOT |
| **UI layer** | Real native views | Bridged | Custom renderer (Skia) |
| **Hot reload** | Yes, **with state** | Yes | Yes |
| **GC pauses mid-animation** | Minimal | Present | Present |
The killer argument for compiled Crystal over JS/Dart in mobile:
**no garbage-collection jitter during real-time UI work**.
## The API
Ruby-like syntax, C-like speed, real native views:
```crystal
class CounterApp < Native::App
  @[Preserve]
  property count : Int32 = 0
  def setup
    @label = Native::UI::TextView.new("Taps: #{@count}")
    btn = Native::UI::Button.new("Tap Me")
    btn.on_click {
      @count += 1
      @label.text = "Taps: #{@count}"
    }
    layout = Native::UI::LinearLayout.new
    layout.addView(@label)
    layout.addView(btn)
    @root = layout
  end
end
```
`setup` is the only required method. Assign `@root`, and you're done.
## The part I care about most: the JNI layer
This is where the engineering gets serious. The Android engine
**hand-rolls the JNI function table**, and every slot is verified against
OpenJDK's `jni.h`. All framework code goes through `JNIHelpers`, a typed layer
that owns the lifecycle of every JNI local reference — so the framework
**cannot leak them**.
Most projects just use the C preprocessor macros and pray. This is careful,
typed, leak-proof systems design, and it's the part worth studying.
## Hot reload with state
The hot reload design is arguably better than Flutter's for stateful apps:
1. `@[Preserve]` marks properties worth keeping
2. On reload, state is serialized to JSON
3. The process is killed and recompiled **incrementally**
4. State is restored on boot
Round-trip is ~1.3 seconds **with state intact**. Kill the process, keep the
counter. That's how hot reload should work.
## Platform status
| Platform | Status |
|---|---|
| Android 7.0+ | **Stable** |
| iOS 11+ | **Stable** |
| Desktop (dev) | Dev only (SDL + OpenGL) |
| Windows / Linux / WASM | Roadmap |
## Takeaways
- Crystal can hold its own in territory usually reserved for C and Rust
- Typed FFI wrappers with explicit reference ownership beat "manual cleanup + hope"
- Hot reload doesn't require a VM — just serialization, incremental compile, restore
- The Crystal ecosystem is growing in directions nobody predicted a year ago
If you're doing systems work in Crystal, read the JNI engine source. It's a
masterclass in FFI design.

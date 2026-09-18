
---
title: native.cr — How Crystal Ends Up on Your Phone
tagline: Hand-rolled JNI, FFI into UIKit, and hot reload with zero runtime — a deep dive
date: 2026-09-18
tags: [crystal, mobile, ffi, jni, systems]
---
# native.cr — How Crystal Ends Up on Your Phone
> [native.cr](https://github.com/slick-lab/native.cr) describes itself as
> "React Native, but for Crystal." That tagline undersells it. What it actually
> is: a framework that compiles Crystal to native ARM64 and drives **real
> platform UI** — JNI on Android, raw FFI into UIKit on iOS — with no JS bridge,
> no Dart VM, and no interpreter anywhere in the stack.
I've spent a lot of time thinking about what Crystal is actually good for.
Libraries like `speak` and `Agent.cr` live in one corner of that answer —
performance-sensitive backend work. `native.cr` lives in a completely different
corner, and honestly, it's the more impressive one. Mobile is the hardest
proving ground for a compiled language: real-time UI, tight memory budgets,
platform APIs designed for C and Java. This project clears that bar. This post
is my breakdown of **how**.
## The problem with every cross-platform framework
Every mainstream mobile framework pays a runtime tax somewhere:
- **React Native** serializes calls across a JS-to-native bridge (or runs
  Hermes, which is still a VM).
- **Flutter** ships the Dart runtime and renders the entire UI itself with
  Skia/Impeller — your app doesn't contain a single native view.
- **Native Java/Kotlin/Swift** — great, but you write two apps.
The bridge tax shows up as latency on every UI interaction. The renderer tax
shows up as binary size, memory, and the subtle "doesn't quite feel native"
problem. The GC tax shows up as frame drops when a collection fires mid-scroll.
`native.cr`'s bet is that you can delete all three taxes if your language
compiles to machine code and your UI layer *is* the platform UI. Crystal gives
you the first part for free. The framework builds the second.

## What "real native views" actually means
This is the part people skim past, and it's the most important part.
When you write this in `native.cr`:
```crystal
label = Native::UI::TextView.new("Taps: 0")
```
you are not creating a widget object in some virtual tree that gets diffed and
reconciled later. You are constructing an actual `android.view.View` subclass
**on the Android side**, through JNI, and holding a reference to it. The
`TextView` *is* the platform TextView. Accessibility works. Fonts, IME input,
text selection, platform animations — all of it works, because it's not
reimplemented, it's *borrowed*.
On iOS it's the same story, except instead of JNI the framework makes raw FFI
calls into **UIKit**. Crystal's FFI is C-level, and Objective-C is dynamic
enough that you can message classes and instances directly once you have the
right plumbing. Same mental model: your Crystal object wraps a real Objective-C
object, not a facsimile of one.
This is a fundamentally different architecture from Flutter. Flutter owns every
pixel. `native.cr` owns none of them — and that's the point.
## The API: Ruby-shaped, C-fast
The whole app surface is deliberately tiny. One class, one method, one
assignment:
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
Rules of the framework:
1. Subclass `Native::App`
2. Implement `setup`
3. Assign `@root`
That's the entire contract. Note the `@[Preserve]` annotation on `count` —
hold that thought, because it's the key to the hot reload design, and it's the
cleverest idea in the whole project.
The API feels Ruby-like because Crystal does, but don't let that fool you.
Every method call in that snippet crosses a language boundary — it's a JNI call
on Android, an Obj-C message send on iOS. The Ruby-shaped surface is sitting on
top of genuinely low-level machinery.
## The JNI layer is where this project earns its reputation
If you want to understand why this framework is trustworthy rather than
clever-but-fragile, read the Android engine. Here's the summary:
**The framework hand-rolls the JNI function table.** Most projects that touch
JNI use the C preprocessor macros (`(*env)->FindClass(...)`) and trust that
things line up. `native.cr` instead builds the JNI interface table itself and
**verifies every slot against OpenJDK's `jni.h`**. If a function pointer lands
in the wrong slot, you find out at build/validation time, not as a segfault in
production on some random device.
Why does this matter? JNI function tables are ordered structs of function
pointers. Get one offset wrong and you're calling `GetStringUTFLength` when you
meant `GetStringLength` — memory corruption, undefined behavior, crashes that
reproduce on one phone and not another. Verifying every slot against the
canonical header is the paranoid, correct thing to do, and almost nobody does
it.
Second: **all framework code goes through `JNIHelpers`, a typed layer that owns
the lifecycle of every JNI local reference.**
If you've written JNI, you know the pain. JNI local references are pinned
until the native frame returns to Java — write a loop that creates 10,000
references without deleting them and you blow the local reference table and the
VM kills your process. Every JNI codebase has that one leak that only shows up
on long-running screens. `JNIHelpers` makes that class of bug *unwritable* in
framework code: the helper owns creation and deletion, the framework can't
forget.
This is exactly the kind of design I care about — the same instinct behind
typed wrapper layers in `Agent.cr`'s handler chain. Boundaries between worlds
(memory ownership, lifecycles, error propagation) are where systems software
dies. Pushing that complexity into one audited layer instead of scattering it
across every call site is what separates "works in the demo" from "works in
production."
## Hot reload, with state, and no VM
Here's the puzzle: hot reload is table stakes for mobile development. But hot
reload is usually sold as a *feature of having a runtime* — JS and Dart can hot
reload because the VM keeps state alive while code swaps underneath it. Crystal
compiles to a native binary with no VM. There's nothing to "swap underneath."
`native.cr`'s solution is genuinely elegant:
```mermaid
flowchart LR
    A["@[Preserve] properties"] --> B["serialize to JSON"]
    B --> C["kill process"]
    C --> D["incremental recompile"]
    D --> E["restart process"]
    E --> F["restore state"]
    F --> G["UI intact"]
```
1. `@[Preserve]` marks which properties are worth keeping across a reload —
   an explicit, opt-in contract instead of a heuristic snapshot of everything.
2. On save, state serializes to JSON, the process is killed, and the binary
   recompiles **incrementally** — only the changed translation units, not a
   full rebuild.
3. The new process boots, deserializes the state, and your UI comes back
   exactly where you left it.
Round-trip is **about 1.3 seconds, with state intact**. Kill the process, keep
the counter. The counter is literally the demo — you tap it 20 times, hit save,
and it comes back reading 20.
I'd argue this is *better* than VM-based hot reload for stateful apps. VM hot
reload keeps everything alive, including the code paths you *wanted* to reset.
Here the contract is explicit: what's marked survives, what isn't doesn't. That
clarity is worth more than the extra 800ms.
The lesson generalizes beyond mobile: **hot reload doesn't require a runtime —
it requires serialization, incremental compilation, and a restart.** That's a
pattern you can steal for any compiled-language dev loop.
## Why no GC jitter is a bigger deal than it sounds
Everyone says "compiled languages are faster" and shrugs. The specific claim
here is narrower and more interesting: **no garbage collection pauses during
real-time UI work.**
Crystal has a GC (Boehm), so it's not that there's no GC — it's that the
allocation profile of a well-written Crystal UI loop is nothing like the
allocation profile of a JS UI loop. Every React re-render allocates closures,
arrays, and virtual DOM nodes; the GC eventually has to collect them, and when
it does mid-frame, you drop one. Everyone building with RN has seen it.
With `native.cr`, your Crystal code allocates mostly on setup. During a frame,
you're making FFI calls into platform code that mutates *platform-owned* views.
There's no virtual tree re-allocating per frame. The steady-state allocation
rate is close to zero, so the GC has nothing to collect, so it never fires
mid-frame. That's not an optimization — it's a structural property of the
architecture.
This is the same structural argument behind using Crystal for LLM inference in
`speak`: it's not that Crystal is magically fast, it's that you can *shape*
where allocation happens instead of having it shaped for you.
## Platform status and honest caveats
No deep dive is complete without the fine print.
| Platform | Status |
|---|---|
| Android 7.0+ | **Stable** |
| iOS 11+ | **Stable** |
| Desktop (dev) | Dev-only, SDL + OpenGL |
| Windows / Linux / WASM | Roadmap |
What "stable" means here: Android and iOS are production-viable targets.
Desktop is for development iteration, not shipping. The remaining platforms are
on the roadmap, not shipped.
The honest trade-offs of this architecture:
- **You inherit the framework's youth.** A five-year-old Flutter question has a
  Stack Overflow answer; a `native.cr` question has a GitHub issue. That's the
  price of being early.
- **One codebase, two dialects.** `TextView` and `UIView` are wrapped behind a
  common API, but the underlying platforms are not the same. Complex apps will
  hit platform divergence.
- **Ecosystem gravity.** The RN/Flutter ecosystems have a decade of packages.
  Crystal mobile has… the stdlib and whatever you write. If you're building
  systems tooling anyway (and if you're reading this blog, you probably are),
  that's less of a problem than it sounds.
None of these are disqualifying. They're the standard tax on any young
framework, and the core architecture is sound enough to be worth paying.
## What I'm actually taking from this
Three things, in order of usefulness:
1. **Typed boundary layers beat manual discipline.** `JNIHelpers` owning every
   local reference is the pattern. If you're bridging two worlds — JNI, FFI,
   C interop, even subprocess management — build one layer that owns the
   lifecycle and make bypassing it impossible. Verification of the JNI table
   against `jni.h` is the same idea at build time: move the bug from runtime to
   compile time whenever you can.
2. **Hot reload is serialization + incremental compile + restart.** No VM
   required. The `@[Preserve]` opt-in contract is the design detail that makes
   it clean — explicit over implicit, always.
3. **The strongest technical bets are structural, not incremental.** "No GC
   pauses mid-frame" isn't a tuning win, it's a consequence of not re-allocating
   a virtual tree every frame. "Real native views" isn't a feature, it's the
   absence of a rendering layer. When you can win by *deleting* a component
   instead of optimizing it, take that bet every time.
If you're doing systems work in Crystal — or you just want to see what careful
FFI design looks like — read the Android engine source. It's the best part of
the project, and it's a masterclass regardless of whether you ever ship a
mobile app.
---
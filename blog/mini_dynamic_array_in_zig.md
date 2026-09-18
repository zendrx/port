---
title: how to implement dynamic array in zig
taglind: array, zig, memory
---

# How to implement dynamic array 

dynamic array in my terms is simply an array that continues  to grow to fit the demand of elements(items) it needs to contain 

to start this blog post uses the latest zig version 

```bash
$ zig version
  0.16.0
```

```zig
const std = @import("std");

fn Array(comptime T: type) type {
    return struct {
        const Self = @This();

        ptr: [*]T,
        capacity: usize,
        len: usize,

        pub fn init(alloc: std.mem.Allocator) !Self {
            const buffer = try alloc.alloc(T, 4);
            return Self{
                .ptr = buffer.ptr,
                .capacity = buffer.len,
                .len = 0,
            };
        }

        pub fn deinit(self: *Self, alloc: std.mem.Allocator) !void {
            const buffer = self.ptr[0..self.capacity];
            alloc.free(buffer);
        }

        pub fn append(self: *Self, alloc: std.mem.Allocator, item: T) !void {
            if (self.len == self.capacity) {
                try self.grow(alloc);
            }
            self.ptr[self.len] = item;
            self.len += 1;
        }

        pub fn pop(self: *Self) !T {
            if (self.len == 0) {
                return error.Empty;
            }
            self.len -= 1;
            return self.ptr[self.len];
        }

        fn grow(self: *Self, alloc: std.mem.Allocator) !void {
            const new_c = self.capacity * 2;
            const old_slice = self.ptr[0..self.capacity];
            const new_m = try alloc.realloc(old_slice, new_c);
            self.ptr = new_m.ptr;
            self.capacity = new_m.len;
        }
    };
}

```

**this is not all there is to a dynamic array although this is a nice building block**

- Explained:

`const std = @import("std");` import the zig stdlib,

after importing the stdlib we create a struct to hold:
- ptr: pointer to the memory address 
- capacity: number of total block in that address
- len total blocked used 

> Note: len must not be bigger than capacity
> we consider item after len as garbage thus you should do bound check during `append`, `insert` ...e.t.c

inside our struct we have function append this append the item to the last 
first you make sure len is not >= capacity if it does you have to resize the array this is the whole point of beign a **dynamic array**

after the growing of the memory block its safe to insert the item increase the length `self.len += 1;`

the next function is `deinit` this should be called with `defer` unless some reason known to the user. it constructs the full slice using the ptr and capacity `self.ptr[0..self.capacity];` and frees the slice 

then we have `pop` pops out the last item from the array and returns it 
```zig
self.len -= 1;
return self.ptr[self.len];
```

lastly we have grow to reallocate the memory to be bigger and contain more item like have mentioned earlier recreate the slice from the ptr and capacity increase the previous capacity by 2 and call realloc 

> in some cases realloc gives back the same address but to be safe update the ptr and the capacity to point to the newly allocated memory 


Now then lets try our code shall we

append the following to the previous code save the file has array.zig

```zig

pub fn main(init: std.process.Init) !void {
  const alloc = init.gpa;
  var list = Array(u32).init(alloc);
  defer list.deinit(alloc);
  try list.append(alloc, 10);
  try list.append(alloc, 20);
  try list.append(alloc, 30);
  
  const item = list.pop();
  std.debug.print("popped: {d}\n", .{item});
 }
 ```

 
 ```bash
 zig run array.zig
 popped: 30
 
 ```
 
 > Heads up don't forget to finish up the array
 > implement `item`, `insert`, `removeWithIndex` etc


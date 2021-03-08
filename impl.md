# Implementation Notes

## Callback Storage

A task stores 0..N "mapper" functions and 0..N "deiniter" functions.

We switch between: storing one function as-is; storing several in an array; several in a queue. Switching between the three types seems to have no penalty other than code size, and saves serious amounts of memory, leading to better performance overall.

When switching to the "array" mode, we try to allocate an array of a specific size. At the time of writing, V8 defaults to 20 slots for empty arrays; for array literals it matches the literal's size. Most tasks won't have anywhere near 20 mappers or deiniters, so we make a smaller array with a bit of buffer space and truncate it, hoping the engine doesn't reallocate when truncating. Sometimes our heuristic will miss, but on average it should save memory and CPU. Needs testing in other engines.

When the array gets large enough, using it for FIFO becomes a bottleneck. JS arrays have decent scaling on push/pop, but bad scaling on unshift/shift. FIFO requires push/shift. After a certain threshold, we construct a FIFO queue to avoid this bottleneck while reusing the array. Until that threshold, using a queue seems to be slower overall, possibly due to more allocator/GC work. The current threshold was picked for the contemporary V8, and may be wrong for other engines or become obsolete in the future V8 versions.

# Run 276: Sprite storage stall during npm installation

Inspected live on 2026-09-12, approximately 11:48–11:54 UTC.

The immediate failure is a persistent filesystem I/O stall inside the Sprite,
not an established native-addon compatibility problem. The exact provider/kernel
defect is still unconfirmed. No run cancellation, VM restart, checkpoint restore,
or repository modification was performed during diagnosis.

## Identity and timeline

- Run: `276`, task: `T-20260912-0012`.
- Sprite: `to-run-pool-a27339b71d97-a9a0784c-1c13-4ab9-9945-cc766773403c`.
- Worker incarnation: `2026-09-12T10:52:46.501443945Z#732`.
- Kernel: `6.12.105-fly`; Node: `v22.22.3`.
- 10:51:50 UTC: pool hit, explicitly `dependencyBaseline: false`.
- 10:52:12: baseline restored. This was a worker baseline, without project deps.
- 10:56:28: initial test fails because Jest is absent.
- 10:56:43: agent starts `npm install` in the repository.
- 11:00:45: `node_modules` occupies 5.5 GiB.
- 11:00:49: process listing shows several `prebuild-install`, `node-gyp-build`,
  and `buildcheck.js` lifecycle commands.
- 11:02:01: agent reports stopping the apparently hung native install.
- At inspection, the subsequent npm test process had been alive for about
  46 minutes and was blocked in filesystem I/O. The persisted tool-use message
  appeared at 11:47:12; that timestamp does not represent actual process start.
- The control-plane trace still reported the run and runner as `running`.

## Direct evidence

`ps -eo pid,ppid,etime,stat,wchan:30,args` showed:

```text
732   ... Ssl ep_poll                  node dist/run-worker.js 276
1502  ... Zl  -                        [codex] <defunct>
2066  ... Zsl -                        [npm install] <defunct>
2966  ... Ds  jbd2_log_wait_for_space   npm test --runInBand ...
2989  ... D   wait_on_buffer           run-parts ... /etc/profile.d
```

PID 2989 was spawned by the diagnostic login shell. Even listing profile scripts
blocked; inspection succeeded using `/bin/sh -c` and procfs/sysfs reads instead.

The test process's kernel stack traversed
`__jbd2_log_wait_for_space → jbd2__journal_start → ext4_dirty_inode →
ext4_file_write_iter → ovl_write_iter → ksys_write`.
The login shell's child was blocked in
`__wait_on_buffer → ext4_read_bh → ext4_dx_readdir → ovl_iterate`.

The zombie process leaders did not mean all their threads had exited:

```text
npm thread 2075: do_unlinkat
npm thread 2076: rq_qos_wait
npm thread 2077: __jbd2_log_wait_for_space
npm thread 2078: do_unlinkat
Codex thread 2964: __jbd2_log_wait_for_space
Codex thread 2965: __jbd2_log_wait_for_space
```

Two samples of `/proc/diskstats` / `/sys/block/loop0/stat` had identical
completion counters: 26,463 reads, 78,404 writes, and 856 flushes, with 17 I/Os
in progress. The I/O time counter increased while completions remained frozen.
`/proc/pressure/io` reported approximately 99% for both `some` and `full`.

`dmesg` contained a warning from `kswapd0` at
`mm/page_alloc.c:4305 __alloc_pages_slowpath.constprop.0`, with a stack through
`ext4_get_inode_loc`, `ext4_dirty_inode`, `iput`, `prune_dcache_sb`, and
`shrink_slab`. This is evidence of a problem during filesystem memory reclaim;
it does not establish the precise deadlock or prove swap caused it.

Memory at inspection: about 3.3 GiB available of 15.6 GiB total. The configured
4 GiB `/tmp/task-orchestrator.swap` existed and used only about 4.5 MiB.
The inspected cgroup reported no OOM kills. These are point-in-time observations,
not proof that the VM never experienced earlier memory pressure.

The Sprite CLI's HTTP exec printed procfs output but ended with
`no exit frame received`; the output is diagnostic evidence, not a successful
command-exit receipt. The original WebSocket/login-shell inspection also hung.

## Recovery and prevention

1. Preserve the task's changed source and git state before recovery. A restore
   to the worker baseline predates the task checkout and would discard work.
   Do not use terminal run cancellation as a benign restart: it can delete the
   Sprite and unpublished checkout state.
2. Give the Sprite identity, kernel warning, blocked thread stacks, and frozen
   loop-device counters to the provider. Provider-assisted VM recovery or a
   replacement environment is the next operational step; restarting only the
   Node worker does not reset the blocked filesystem.
3. After recovering the checkout, finish dependency installation and run the
   requested tests with working native bindings. A partially populated tree is
   not a successful installation. Neither a Node downgrade nor `--ignore-scripts`
   is an evidenced fix for this incident.
4. Separately, configure a repository dependency baseline for this large
   monorepo, with its setup/build/readiness commands and native-binding probes.
   Run 276's worker-only pool hit did not preinstall those dependencies. This
   reduces repeated cold installs but is not a demonstrated kernel-stall fix.

For comparison only, a separate first-hand [Sprite fsync latency report](https://community.fly.io/t/sprites-fsync-issues/27068)
describes slow durable writes affecting package installs and git. It does not
prove the same cause as run 276's frozen I/O.

## Repeating the non-mutating checks

Use the exact Sprite above with `sprite exec --http-post -s <name> -- /bin/sh -c`.
Avoid a login shell and avoid adding writes or `sync` to an already blocked VM.
Read `ps -eLo pid,tid,ppid,stat,wchan:30,args`, `/proc/pressure/io`,
`/proc/diskstats`, `/proc/<pid>/task/<tid>/stack`, and `dmesg`. Compare disk
completion counters across samples instead of assuming an npm process listing
means native compilation is progressing.

## Research follow-up: 2026-09-12

The leading hypothesis is that the large install put pressure on memory and
filesystem caches, exposing a reclaim/I/O forward-progress failure in the legacy
Sprite storage stack. Memory ballooning is a plausible contributor. The
filesystem stall is confirmed; the exact circular wait and initiating cause
remain unproven without the platform-side storage and kernel-worker stacks.

### Additional live evidence

A non-mutating sample at **12:02:17 UTC** returned:

```text
/sys/block/loop0/loop/backing_file:
/dev/fly_vol/juicefs/data/active/root-upper.img

balloon_inflate          3260416
balloon_deflate          1425408
pgscan_kswapd           11374221
pgscan_direct            960566
workingset_refault_file  3760451
allocstall_normal          4130
allocstall_movable        13724
oom_kill                     0
```

The net balloon counter is 1,835,008 pages, equivalent to 7 GiB with 4 KiB
pages. These cumulative counters show substantial balloon activity and reclaim,
not when balloon inflation occurred relative to the install. Do not subtract
that number from current `MemTotal` to assert usable RAM: current Sprite docs
describe adjusted memory reporting. There was no sampled OOM kill.

`loop0` still had exactly 26,463 completed reads, 78,404 completed writes, 856
completed flushes, and 17 outstanding I/Os. Thus the frozen counters persisted
through the later research sample, not just two closely spaced probes.
Both I/O pressure averages were now 99.00% over all reported intervals.

### Why this architecture can stall

Fly's January 14 engineering article describes the original storage stack as
a modified JuiceFS implementation with SQLite metadata, Litestream replication,
and object-storage chunks cached on local NVMe. Storage management runs inside
the VM, outside the user's container namespace. The observed loop backing path
identifies run 276 as using that legacy layout. The user-visible path is roughly
application → overlayfs → ext4 → loop-backed image → platform storage stack.
[Fly's original design](https://fly.io/blog/design-and-implementation/).

This adds dependencies between disk progress, memory available for caches and
metadata, and the platform storage process. A large package installation can
exercise those paths heavily. Linux documents how memory reclamation can
re-enter filesystem/I/O code while resources are already held, creating
deadlocks unless allocation contexts are handled correctly. This explains a
possible mechanism; it does not prove which layer owns run 276's blocked I/O.
[Linux filesystem/I/O allocation guidance](https://docs.kernel.org/core-api/gfp_mask-from-fs-io.html).

The `kswapd → shrink_slab → iput → ext4_dirty_inode → allocation` warning
resembles an upstream report discussed in April 2025 on Linux 6.12.19. Kernel
maintainers explain that a no-fail allocation during reclaim can leave the
reclaimer depending on other reclaimers for progress. The upstream 6.12.105
allocator has an explicit warning for `PF_MEMALLOC` with `__GFP_NOFAIL`.
Our `-fly` kernel has different source line numbers; this is a matching warning
class, not a verified patch-level root cause or a confirmed fix.
[Maintainer discussion](https://lkml.iu.edu/hypermail/linux/kernel/2504.0/04069.html),
[upstream allocator source](https://raw.githubusercontent.com/gregkh/linux/v6.12.105/mm/page_alloc.c).

### Closest external incident

On February 12–13, a Sprite user reported heavy balloon inflation, file-cache
eviction, repeated disk reads and a `kswapd` fault during slab reclaim. Fly staff
confirmed that Sprites use ballooning to reclaim unused memory and acknowledged
the page-cache tradeoff. This supports the memory-pressure hypothesis but does
not establish that the February policy is unchanged or that its incident and
run 276 share one bug.
[First-hand report and Fly staff replies](https://community.fly.io/t/virtio-balloon-overcommit-causing-severe-memory-thrashing-on-8-cpu-8gb-firecracker-vms/27124).

Current documentation says Sprite memory is platform-managed and can scale
under pressure. It does not promise that guest-reported total RAM is a fixed
allocation for sizing workloads.
[Current lifecycle and resource contract](https://docs.sprites.dev/concepts/lifecycle/).

### A relevant platform change

Fly has announced **Sprite Block Device (SBD)** as a rewrite of the original
JuiceFS/Litestream storage stack, with reliability improvements and drive
forking. The current product page explicitly describes this backend as early
access, enabled per organization. Do not assume a fresh Sprite automatically
uses SBD, or that changing the Node worker bundle upgrades storage.
[Rewrite announcement](https://fly.io/blog/kurt-scott-money-sprites/),
[current SBD availability](https://fly.io/sprites/).

No source found establishes that SBD fixes this specific kernel stall. The
practical next experiment is a provider-confirmed SBD environment running the
same pinned repository install, compared with the legacy backend, recording
balloon deltas, memory/I/O pressure and disk completions throughout. Separately,
compare cold installation with the configured repository dependency baseline.
Keep those variables separate so a faster warm install is not mistaken for a
storage fix.

Ask Fly to identify the blocked legacy storage request and obtain the VM-root
`kswapd`, journal, loop-worker and JuiceFS stacks, plus balloon history. Those
are the missing observations needed to discriminate kernel reclaim deadlock,
userspace storage stall and downstream storage failure. No provider message
was sent, and no resource settings or storage backend were changed.

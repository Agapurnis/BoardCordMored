/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// TODO: cleanup doesnt actually wokr

import * as child_process from "child_process";
import type { IpcMainInvokeEvent } from "electron";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as stream from "stream";
import { promisify } from "util";
const exec = promisify(child_process.exec);

import { getExitHook } from "@utils/dependencies";
import EventEmitter from "events";
import type { PartialDeep, TypedArray } from "type-fest";

function defaultsDeep<T extends object, S extends object>(target: T, source: S): T & S {
    for (const key in source) {
        if (source[key] instanceof Object && key in target) {
            (target as T & S)[key] = defaultsDeep((target as T & S)[key] as any, source[key] as unknown as object);
        } else {
            (target as T & S)[key] = source[key] as any;
        }
    }
    return target as T & S;
}

import { assertUnreachable, ChatbubbleExportFormat, ChatbubbleFFmpegDelegationFailure, ChatbubbleFFmpegDelegationFailureKind, ChatbubbleFFmpegOptions, ChatbubbleFFmpegTime } from "./shared";
function assertCompileTimeUnreachable(value?: never) { }

type Nullish = null | undefined;

function clamp(value: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, value));
}

namespace Temporary {
    export class FileManager {
        protected static readonly FILTER_INCLUDE_ALL = (path: string, entry: fs.Dirent) => true;
        protected static readonly managerFinalizationRegistry = new FinalizationRegistry<FileManager.Token>(token => {
            this.exitListeningManagers.delete(this.managerReferenceTokenMap.get(token)!);
            this.managerReferenceTokenMap.delete(token);
        });
        protected static readonly managerReferenceTokenMap = new WeakMap<FileManager.Token, WeakRef<FileManager>>();
        protected static readonly exitListeningManagers = new Set<WeakRef<FileManager>>();
        protected static exiting = false;
        static {
            getExitHook().then(({ asyncExitHook }) => {
                asyncExitHook(async () => {
                    FileManager.exiting = true;
                    const time = process.hrtime.bigint();
                    const managers = [...FileManager.exitListeningManagers];// .reverse(); // TODO: Order in a more robust manner.
                    await Promise.all(managers.map(ref => ref.deref()?.cleanup()));
                    console.log("Cleanup: ", Number((process.hrtime.bigint() - time) / 10000n) / 100, "ms");
                }, { wait: 25 /* ms */ });
            });
        }

        public readonly config: FileManager.Configuration;
        public readonly path: string;
        protected readonly registered = new Set<string>();
        protected readonly token?: FileManager.Token;

        public get status() { return this._status; }
        private _status = FileManager.Status.PENDING;

        public initialized: Promise<this>;

        constructor(config:
            | FileManager.Configuration
            | FileManager.Configuration.PartialInputObject,
            then?: (instance: FileManager) => void | Promise<void>
        ) {
            this.config = (config instanceof FileManager.Configuration) ? config : FileManager.Configuration.prepare(config);
            this.path = this.config.path;

            if (
                // TODO: Bitflags?
                this.config.cleanup.when === FileManager.Configuration.Cleanup.Occasion.ONLY_EXIT ||
                this.config.cleanup.when === FileManager.Configuration.Cleanup.Occasion.ON_EXIT_OR_EXPLICIT
            ) {
                const token = new FileManager.Token();
                const ref = new WeakRef(this);
                FileManager.managerFinalizationRegistry.register(this, token);
                FileManager.managerReferenceTokenMap.set(token, ref);
                FileManager.exitListeningManagers.add(ref);
            }

            let make = this.config.where[2];
            if (make === true || make === undefined) make = { recursive: true };
            if (make) {
                this.initialized = fsp.mkdir(this.path, { recursive: true }).then(() => {
                    this._status = FileManager.Status.READY;
                    const p = then?.(this);
                    if (p) return p.then(() => this);
                    else return Promise.resolve(this);
                });
            } else {
                this._status = FileManager.Status.READY;
                this.initialized = Promise.resolve(this);
            }
        }

        private async getPathsToDelete(entries: fs.Dirent[], filter = FileManager.FILTER_INCLUDE_ALL): Promise<string[]> {
            const filtered = new Array<string>(entries.length); let index = 0;
            switch (this.config.cleanup.include) {
                case FileManager.Configuration.Cleanup.Inlcude.ALL: {
                    for (const entry of entries) {
                        const p = path.resolve(entry.parentPath, entry.name);
                        if (filter(p, entry)) filtered[index++] = p;
                    }
                    filtered.length = index;
                    return filtered;
                }
                case FileManager.Configuration.Cleanup.Inlcude.ALL_FILES: {
                    for (const entry of entries) {
                        const p = path.resolve(entry.parentPath, entry.name);
                        if (entry.isDirectory()) continue;
                        if (filter(p, entry)) filtered[index++] = p;
                    }
                    filtered.length = index;
                    return filtered;
                }
                case FileManager.Configuration.Cleanup.Inlcude.MANAGED_FILES: {
                    for (const entry of entries) {
                        const p = path.resolve(entry.parentPath, entry.name);
                        if (entry.isDirectory() || !this.registered.has(p)) continue;
                        if (filter(p, entry)) filtered[index++] = p;
                    }
                    filtered.length = index;
                    return filtered;
                }
                default: assertUnreachable(this.config.cleanup.include);
            }
        }

        public async cleanup(filter?: typeof FileManager.FILTER_INCLUDE_ALL): Promise<void> {
            try {
                if (this.status !== FileManager.Status.READY) return;
                const c = this.config.cleanup;
                if (c.when === FileManager.Configuration.Cleanup.Occasion.NEVER) return;
                if (c.when === FileManager.Configuration.Cleanup.Occasion.ONLY_EXIT && !FileManager.exiting) return;
                if (
                    c.ascension === FileManager.Configuration.Cleanup.Ascension.SELF &&
                    c.include === FileManager.Configuration.Cleanup.Inlcude.ALL &&
                    filter === FileManager.FILTER_INCLUDE_ALL
                ) return fsp.rm(this.path, { recursive: true });
                const entries = await fsp.readdir(this.path, { withFileTypes: true });
                const paths = await this.getPathsToDelete(entries, filter);
                if (entries.length === paths.length && c.ascension === FileManager.Configuration.Cleanup.Ascension.SELF) {
                    return fsp.rm(this.path, { recursive: true });
                }
                await Promise.all(paths.map(path => {
                    // TODO: Decide on symlink behavior? I mean, I'm not using them...
                    return fsp.rm(path, { recursive: true });
                }));
            } catch (e) { console.warn(e); }
        }


        protected counter = 0;
        /**
         * @return a unique generated path for a file
         */
        public unique(options?: { prefix?: string, suffix?: string; }) {
            let out = String();
            if (options?.prefix) out = options.prefix;
            out += (this.counter++);
            if (options?.suffix) out += options.suffix;
            return path.resolve(this.path, out);
        }

        public register(path: string) {
            this.registered.add(path);
        }
        public unregister(path: string) {
            this.registered.delete(path);
        }

        /*
         * @return a handle to the file
         */
        public async create(prefix?: string, suffix?: string): Promise<fsp.FileHandle & { path: string; }> {
            const path = this.unique({ prefix, suffix });
            await this.initialized;
            const handle = await fsp.open(path, "w");
            this.register(path);
            return Object.assign(handle, { path });
        }
    }
    export namespace FileManager {
        export class Token { }

        export const enum Status {
            /**
             * The directory to contain the files has not yet been made.
             */
            PENDING,
            /**
             * The manager is able to create new temporary files, assuming the directory has been made.
             */
            READY,
        }

        export interface ConfigurationObject {
            /**
             * Where to insert the temporary files.
             */
            where: [basis: Configuration.Backend | FileManager | string | Nullish, scope: string, options?: boolean | fs.MakeDirectoryOptions];
            /**
             * How and when to cleanup the contents of this manager.
             */
            cleanup: Configuration.Cleanup,
        }
        export class Configuration implements Configuration.FrozenObject {
            public constructor(input: Configuration.PartialInputObject, base?: Configuration) {
                return Configuration.prepare(input, base);
            }
            public readonly where!: ConfigurationObject["where"];
            public readonly cleanup!: ConfigurationObject["cleanup"];
            public get path() {
                const [basis, scope] = this.where;
                return path.resolve(basis instanceof FileManager ? basis.path : Configuration.resolveBackend(basis ?? Configuration.Backend.NODE_DETERMINED), scope);
            }
        }
        export namespace Configuration {
            export type PartialInputObject = PartialDeep<ConfigurationObject> & Pick<ConfigurationObject, "where">;

            export interface Cleanup {
                /**
                 * Whether the containing directory/directories should be removed.
                 */
                ascension: Cleanup.Ascension,
                /**
                 * When to clean up the contents of the the directory.
                 */
                when: Cleanup.Occasion;
                /**
                 * What should be included in the clean-up.
                 */
                include: Cleanup.Inlcude;
            }
            export namespace Cleanup {
                export const enum Occasion {
                    /**
                     * Cleanup on process exit or when the cleanup method is explicitly called.
                     */
                    ON_EXIT_OR_EXPLICIT,
                    /**
                     * Only cleanup when the process is exiting.
                     */
                    ONLY_EXIT,
                    /**
                     * The class will not cleanup unless the method is explicitly called; true cleanup is left to the operating system.
                     */
                    ONLY_EXPLICIT,
                    /**
                     * Don't ever cleanup..? It will be left to the operating system, or you, if you plan on doing something.
                     */
                    NEVER,
                }
                export const enum Ascension {
                    /**
                     * Do not remove the containing folder, or any folders above that.
                     */
                    NONE,
                    /**
                     * Remove the the containing folder if it is empty after being cleaned up.
                     */
                    SELF,
                }
                export const enum Inlcude {
                    /**
                     * Remove all files in the folder that match the filter (even if unrecognized/unmanaged), but leave folders untouched.
                     */
                    ALL_FILES,
                    /**
                     * Remove all files and folders within this folder that match the filter, even if they aren't being managed by this instance.
                     */
                    ALL,
                    /**
                     * Removes all managed files within this instance that match the folder.
                     */
                    MANAGED_FILES,
                }

                export const DEFAULT = Object.seal({
                    ascension: Ascension.SELF,
                    include: Inlcude.MANAGED_FILES,
                    when: Occasion.ON_EXIT_OR_EXPLICIT
                } satisfies Readonly<Cleanup>);
            }


            export const enum Backend {
                /**
                 * The Windows temporary directory folder for this user.
                 */
                WINDOWS_APPDATA_TEMP = "%userprofile%\\AppData\\Local\\Temp",
                /**
                 * The shared Windows temporary directory. (Typically not needed for user programs?)
                 */
                WINDOWS_SHARED_TEMP = "%systemdrive%\\Windows\\Temp",
                /**
                 * The Windows configured temporary directory in the current user environment.
                 * This is typically defaulted as "%userprofile%\AppData\Local\Temp".
                 */
                WINDOWS_ENVIRONMENTAL_TEMP = "%temp%",
                /**
                 * Unix-like system directory for general temporary files.
                 *
                 * Depending on the system, this directory may utilize [`tmpfs`](https://en.wikipedia.org/wiki/Tmpfs),
                 * meaning the contents will avoid being placed on the disk, preferring to stay in memory or falling back to swap.
                 *
                 * @see https://en.wikipedia.org/wiki/Filesystem_Hierarchy_Standard
                 */
                FHS_TMP = "/tmp/",
                /**
                 * Use what NodeJS presumes the current operating system's temporary directory is.
                 *
                 * @see https://nodejs.org/api/os.html#ostmpdir
                 */
                NODE_DETERMINED = "<node-determined>",
            }

            export function resolveBackend(backend: (string & {}) | Backend): string {
                switch (backend) {
                    case Backend.WINDOWS_APPDATA_TEMP:
                    case Backend.WINDOWS_SHARED_TEMP:
                    case Backend.WINDOWS_ENVIRONMENTAL_TEMP:
                    case Backend.FHS_TMP:
                        return backend;
                    case Backend.NODE_DETERMINED: return os.tmpdir();
                    default:
                        const Narrowed: [Extract<typeof backend, Backend>] extends [never] ? true : false = true;
                        return backend;
                }
            }

            export const DEFAULT = Object.seal({
                cleanup: Cleanup.DEFAULT
            } as Readonly<Omit<ConfigurationObject, "where">>);


            export type FrozenObject = SimpleFreezeDeep<ConfigurationObject>;
            type FreezeObjectDeep<T extends object> = { readonly [K in keyof T]: SimpleFreezeDeep<T[K]> };
            type SimpleFreezeDeep<T> = T extends object ? FreezeObjectDeep<T> : T;

            function freeze<T>(value: T): SimpleFreezeDeep<T> {
                if (typeof value !== "object" || value === null) return value as SimpleFreezeDeep<T>;
                Object.freeze(value);
                for (const key of Reflect.ownKeys(value)) {
                    if (typeof value !== "object" || value === null) continue;
                    if (Object.isFrozen(value)) continue;
                    freeze(value[key]);
                }
                return value as SimpleFreezeDeep<T>;
            }

            export function prepare(partial: PartialInputObject, fallback: Omit<ConfigurationObject, "where"> = DEFAULT): Configuration {
                partial = defaultsDeep(partial, fallback);
                Reflect.setPrototypeOf(partial, Configuration.prototype);
                return freeze(partial) as unknown as Configuration;
            }
        }
    }

    export namespace Vencord {
        export const Manager = new FileManager({ where: [null, "vencord"], });
        export namespace Plugins {
            export const Chatbubblification = new FileManager({ where: [Manager, "chatbubble"] });
        }
    }
}


const fftemp = new Temporary.FileManager({ where: [Temporary.Vencord.Plugins.Chatbubblification, "ffmpeg"] });

const enum SocketStatus {
    /**
     * The socket has not yet been initialized, whether that be on the filesystem or the current runtime.
     */
    PENDING = 0,
    /**
     * The socket is open and accepting being piped to/from.
     */
    OPEN = 1,
    /**
     * The stream recieved a "finish" event and the server is no longer accepting any more inputs.
     * At this point, the socket file may have been (or will be) deleted.
     */
    CLOSED = -1,
}

type PublicConstructor<T, A extends unknown[] = any[]> = new (...args: A) => T;
function socketPipeFactory(provider: Temporary.FileManager) {
    /**
     * Utility class for the integration of system-level sockets (or named pipes) with NodeJS streams.
     * @author katini
     *
     * ---
     *
     * The contents of the following class (and its subsequent namespace) are a derivative work of [`fluent-ffmpeg-multistream`](https://github.com/t-mullen/fluent-ffmpeg-multistream),
     * created by Thomas Mullen and made available under the MIT license. The contents of the following class (and its subsequent namespace) are thus licensed under the same license.
     * The full text of the MIT License can be found here: <https://mit-license.org/>.
     * @license MIT
     * @author Thomas Mullen
     * @see https://github.com/t-mullen/fluent-ffmpeg-multistream
     */
    return class SocketPipe {
        // windows *might* work?
        public static SUPPORTED = ["linux", "darwin"].includes(os.platform());

        /**
         * @return a socket that will have the provided readable stream piped to it
         */
        public static reading<T>(this: PublicConstructor<T>, readable: stream.Readable): T {
            return new this(readable, socket => readable.pipe(socket));
        }
        /**
         * @return a socket that will write to the provided stream upon being piped input
         */
        public static writing<T>(this: PublicConstructor<T>, writable: stream.Writable): T {
            return new this(writable, socket => socket.pipe(writable));
        }

        /**
         * The current status of the socket.
         * It will always follow this assignment pattern: `PENDING` => `OPEN` => `CLOSED`
         */
        public get status() { return this._status; }
        protected _status: SocketStatus = SocketStatus.PENDING;

        /**
         * The path to the socket or named pipe.
         * Note that it may not yet exist; ensure the status is marked as open.
         */
        public readonly path: string;

        constructor(stream: stream.Stream, then: (this: SocketPipe, socket: net.Socket) => void) {
            this.path = provider.unique({ prefix: "socket." });
            const server = net.createServer(socket => {
                provider.register(this.path);
                then.call(this, socket);
                this._status = SocketStatus.OPEN;
            });
            stream.on("finish", () => {
                this._status = SocketStatus.CLOSED;
                server.close();
            });
            server.listen(this.path);
        }
    };
}

function reader(data: string, encoding: BufferEncoding): stream.Readable;
function reader(data: ArrayBufferLike | TypedArray | DataView | Buffer): stream.Readable;
function reader(data: ArrayBufferLike | TypedArray | DataView | Buffer | string, encoding?: BufferEncoding) {
    const readable = new stream.Readable();
    readable.push(data, encoding);
    readable.push(null);
    return readable;
}

/**
 * @throws { child_process.ExecException } rejection on command execution failure
 */
async function locateBinary(name: string): Promise<string | null> {
    const command = os.platform() === "win32" ? `where ${name}` : `which ${name}`;
    const result = await exec(command, { windowsHide: true });
    const output = result.stdout.trimStart();
    if (output.length === 0) return null;
    const EOL = output.indexOf("\n");
    return EOL === -1 ? output : output.slice(0, EOL);
}

async function tryGetFfmpegPath(): Promise<
    | [path: string, err: null]
    | [path: null, err: ChatbubbleFFmpegDelegationFailure<
        | ChatbubbleFFmpegDelegationFailureKind.ERROR_FINDING_BINARY
        | ChatbubbleFFmpegDelegationFailureKind.NO_BINARY_AVAILABLE
    >]
> {
    let binary: string | null;
    try {
        binary = await locateBinary("ffmpeg");
        if (binary === null) return [null, { type: ChatbubbleFFmpegDelegationFailureKind.NO_BINARY_AVAILABLE }];
        return [binary, null];
    } catch (error) {
        return [null, {
            type: ChatbubbleFFmpegDelegationFailureKind.ERROR_FINDING_BINARY,
            error: error as child_process.ExecException,
        }];
    }
}

class FFmpegSocket extends socketPipeFactory(fftemp) {
    // https://github.com/FFmpeg/FFmpeg/blob/6229e4ac425b4566446edefb67d5c225eb397b58/doc/protocols.texi#L2138-L2146
    public get url() { return "unix:" + this.path; }
}


function fixedPrecisionBigIntDivide(numerator: bigint, denominator: bigint, precision: number): string {
    let shift = 1n; for (let i = 0n; i < precision; i++) { shift *= 10n; }
    const int = numerator / denominator;
    const rem = numerator % denominator;
    const ups = rem * shift;
    const dec = String(ups / denominator);
    const pre = precision - dec.length;
    return int.toString() + ((rem !== 0n) ? "." + "0".repeat(pre) + dec : String());
}

class FFmpegJob<T extends FFmpegJob.IO.Method = FFmpegJob.IO.Method> extends EventEmitter<{
    progress: [progress: number],
    failure: [failure: ChatbubbleFFmpegDelegationFailure];
    success: [data: Uint8Array];
    exit: [code: number];
}> {
    public get io() { return this._io.method; }
    private readonly _io: FFmpegJob.IO<T>;
    private readonly process: child_process.ChildProcessWithoutNullStreams;
    private readonly waiting = Promise.withResolvers<void>();
    public readonly life = new AbortController();
    public get running() { return this.process.exitCode === null; }
    /** 0..=1 */
    public get progress() { return this._progress; }
    private _progress = 0;
    private output: Promise<Uint8Array>;

    public static async for(options: ChatbubbleFFmpegOptions): Promise<
        | [job: FFmpegJob, err: null]
        | [job: null, err: ChatbubbleFFmpegDelegationFailure<
            | ChatbubbleFFmpegDelegationFailureKind.ERROR_FINDING_BINARY
            | ChatbubbleFFmpegDelegationFailureKind.NO_BINARY_AVAILABLE
        >]
    > {
        const [binary, err] = await tryGetFfmpegPath();
        if (err) return [null, err];
        const io = await FFmpegJob.IO.get(options);
        const args = FFmpegJob.buildArguments(io, options);
        return [new FFmpegJob({ binary, io, args }), null];
    }

    private async read(): Promise<Buffer> {
        switch (this._io.method) {
            case FFmpegJob.IO.Method.TemporaryFiles: return await fsp.readFile(this._io.paths.out);
            case FFmpegJob.IO.Method.Streaming: return Buffer.concat(this._io.chunks!);
            default: assertUnreachable(this._io.method);
        }
    }

    constructor({ binary, io, args }: { binary: string, io: FFmpegJob.IO<T>, args: string[]; }) {
        super();
        this._io = io;
        this.output = this.waiting.promise.then(_ => this.read().then(buffer => new Uint8Array(buffer)));
        this.output.then(data => {
            this.emit("success", data);
        });
        this.process = child_process.spawn(binary, args, {
            windowsHide: true,
            signal: this.life.signal,
            // FFmpeg doesn't like listening to other signals for me, and we don't really care if the output file is corrupted.
            killSignal: "SIGKILL"
        });

        // TODO: Analyze the error.

        this.process.on("error", error => {
            this.emit("failure", {
                type: ChatbubbleFFmpegDelegationFailureKind.UNKNOWN_ERROR,
                error
            });
        });

        this.process.on("exit", (code, signal) => {
            if (code !== 0) this.emit("failure", {
                type: ChatbubbleFFmpegDelegationFailureKind.UNKNOWN_ERROR,
                error: [code, signal]
            });
        });

        this.process.on("close", (code, signal) => {
            if (code === 0) {
                this.waiting.resolve();
            } else {
                this.emit("failure", {
                    type: ChatbubbleFFmpegDelegationFailureKind.UNKNOWN_ERROR,
                    error: [code, signal]
                });
            }
        });

        this.process.stdout.on("data", (chunk: Buffer) => {
            if (!foundMainLength) return;
            const string = chunk.toString("utf-8");
            const micros = string.match(/out_time_us=(\d+)/)?.[1];
            if (micros === undefined) return;
            const progress = clamp(Number(fixedPrecisionBigIntDivide(BigInt(micros), foundMainLength.microseconds, 5)), 0, 1);
            this._progress = progress;
            this.emit("progress", progress);
        });

        let foundMainLength: ChatbubbleFFmpegTime;
        let foundMain = false;
        let lastChunkPortion = String();
        this.process.stderr.on("data", (chunk: Buffer) => {
            const string = lastChunkPortion + chunk.toString("utf-8");
            console.log(string);
            lastChunkPortion = string.slice(-25);
            if (!foundMainLength) {
                if (!foundMain && string.includes("Input #0")) foundMain = true;
                const time = /Duration:\s*([:.\d]+)/.exec(string)?.[1];
                if (time !== undefined) foundMainLength = ChatbubbleFFmpegTime.parse(time);
            }
        });
    }
}
namespace FFmpegJob {
    export interface IO<T extends FFmpegJob.IO.Method> {
        method: T,
        paths: IO.Paths,
        chunks: T extends FFmpegJob.IO.Method.Streaming ? Uint8Array[] : undefined;
    }
    export namespace IO {
        export type Paths = {
            main: string,
            bubble: string,
            out: string,
        };

        export const enum Method {
            /**
             * FFmpeg IO is done through sockets. This ensures no unnecessary disk writes are made, but limits what can be done.
             */
            Streaming,
            /**
             * FFmpeg IO will be preformed with files located in the system's folder for temporary files.
             *
             * This may result in the disk being stored on RAM (or swap) on some systems which have it configured as such,
             * though otherwise it is no different than interacting with normal files, with the exceptation being that
             * they're normally automatically cleaned up.
             */
            TemporaryFiles,
        }

        export function choose({ inputMime, inputBytes, exportType }: {
            inputMime: string,
            inputBytes: number,
            exportType: ChatbubbleExportFormat;
        }): FFmpegJob.IO.Method {
            if (
                (inputMime === ChatbubbleExportFormat.GIF) ||
                (inputMime.startsWith("video") && exportType === ChatbubbleExportFormat.GIF) || // need entire for palette gen across video ?? idk actually i need more reseach
                (exportType === ChatbubbleExportFormat.MP4) || // fragment are stinky
                (exportType === ChatbubbleExportFormat.WEBM)
            ) return FFmpegJob.IO.Method.TemporaryFiles;

            return FFmpegJob.IO.Method.Streaming;
        }

        export async function streaming(file: ArrayBufferLike, overlay: ArrayBufferLike): Promise<FFmpegJob.IO<FFmpegJob.IO.Method.Streaming>> {
            const chunks = new Array<Uint8Array>();
            const writable = new stream.Writable({
                write(chunk, encoding, callback) {
                    if (!(chunk instanceof Uint8Array)) throw new Error("Received unexpected data type!");
                    chunks.push(chunk);
                    callback();
                }
            });

            const [main, bubble, out] = await Promise.all([
                FFmpegSocket.reading(reader(file)).url,
                FFmpegSocket.reading(reader(overlay)).url,
                FFmpegSocket.writing(writable).url
            ]);

            return {
                method: FFmpegJob.IO.Method.Streaming,
                paths: { main, bubble, out },
                chunks
            };
        }

        export async function files(file: Uint8Array, overlay: Uint8Array): Promise<FFmpegJob.IO<FFmpegJob.IO.Method.TemporaryFiles>> {
            async function mk(prefix: string, content?: Uint8Array) {
                const handle = await fftemp.create(prefix);
                if (content) await handle.write(content);
                await handle.close();
                return handle.path;
            }

            const [main, bubble, out] = await Promise.all([
                mk("main", file),
                mk("bubble", overlay),
                mk("out")
            ]);

            return {
                method: FFmpegJob.IO.Method.TemporaryFiles,
                paths: { main, bubble, out },
                chunks: undefined
            };
        }

        export function get<T extends FFmpegJob.IO.Method>(method: T, file: Uint8Array, overlay: Uint8Array): Promise<FFmpegJob.IO<T>>;
        export function get(options: ChatbubbleFFmpegOptions): Promise<FFmpegJob.IO<FFmpegJob.IO.Method>>;
        export async function get<T extends FFmpegJob.IO.Method>(...args:
            | [options: ChatbubbleFFmpegOptions]
            | [method: T, file: Uint8Array, overlay: Uint8Array]
        ): Promise<FFmpegJob.IO<T>> {
            let method: T;
            let file: Uint8Array;
            let overlay: Uint8Array;
            if (args.length === 3) {
                [method, file, overlay] = args as Extract<Parameters<typeof get<T>>, { length: 3; }>;
            } else {
                const options = args[0];
                method = choose({
                    inputMime: options.file.mime,
                    inputBytes: options.file.data.byteLength,
                    exportType: options.target.type,
                }) as T;
                file = options.file.data;
                overlay = options.overlay.pixels;
            }

            switch (method) {
                case FFmpegJob.IO.Method.Streaming: return streaming(file, overlay) as Promise<FFmpegJob.IO<T>>;
                case FFmpegJob.IO.Method.TemporaryFiles: return files(file, overlay) as Promise<FFmpegJob.IO<T>>;
                default: assertUnreachable(method);
            }
        }
    }

    function outputSpecificationToFfmpegArguments(type: ChatbubbleExportFormat, quality?: number) {
        // TODO: quality
        switch (type) {
            case ChatbubbleExportFormat.WEBM: {
                const out = ["-c:a", "libvorbis", "-c:v"];
                out.push("libvpx"); // todo: option for vp9
                out.push("-f", "webm", "-auto-alt-ref", "0");
                out.push("-cpu-used", "-5", "-deadline", "realtime");
                return out;
            }
            case ChatbubbleExportFormat.MP4: {
                const out = ["-c:v"];
                if (os.platform() === "darwin") out.push("hevc_videotoolbox", "-alpha_quality", "1", "-vtag", "hvc1", "-c:a", "aac", "-pix_fmt", "yuva444p", "-profile:v", "main", "-realtime", "true");
                // TODO
                out.push("-f", "mp4", "-movflags", "+faststart");
                return out;
            }
            case ChatbubbleExportFormat.GIF: return ["-f", "gif"];
            case ChatbubbleExportFormat.PNG: return ["-f", "apng"]; // uhh how do i do normal png this is wasteful
            default: assertUnreachable(type);
        }
    }

    export function buildArguments(io: IO<FFmpegJob.IO.Method>, { file, overlay, target: { type, quality, crop } }: ChatbubbleFFmpegOptions): string[] {
        // TODO: Adding audio, GIF looping, trimming.
        const img2vid = file.mime.startsWith("image") && type.startsWith("video");
        const args: string[] = [];
        args.push("-progress", "-", "-nostats");// , "-loglevel", "error");
        args.push("-y");
        if (img2vid) args.push("-loop", "1");
        args.push("-i", io.paths.main);
        args.push("-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${overlay.bounds.width}x${overlay.bounds.height}`, "-i", io.paths.bubble);
        let filter = String(); let last = "0"; const last_bubble = "1";
        filter += `[${last}]crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1[cropped];`; last = "cropped";
        if (overlay.transparent) {
            filter += `[${last_bubble}]alphaextract[trans];[${last}][trans]alphamerge[overlaid];`; last = "overlaid";
        } else {
            filter += `[${last}][${last_bubble}]overlay=${overlay.bounds.x}:${overlay.bounds.y}[overlaid];`; last = "overlaid";
        }
        if (type === ChatbubbleExportFormat.GIF) {
            // https://superuser.com/a/1323430
            filter += `[${last}]split=[a][b];[a]palettegen[pal];[b][pal]paletteuse=dither=sierra2_4a[paletted];`; last = "paletted";
        }
        args.push("-filter_complex", filter);
        args.push("-map", `[${last}]`);
        args.push("-map", "0:a?"); // TODO: Allow custom audio for image/gif => video
        args.push(...outputSpecificationToFfmpegArguments(type, quality));
        if (img2vid) args.push("-t", "60");
        args.push(io.paths.out);
        console.log(args);

        return args;
    }
}

let job: FFmpegJob | Nullish;
let err: ChatbubbleFFmpegDelegationFailure | Nullish;
getExitHook().then(m => m.default(() => job?.life.abort()));
export async function ffmpeg(_: IpcMainInvokeEvent, options: ChatbubbleFFmpegOptions): Promise<
    | { failure?: never, output: Uint8Array; }
    | { failure: ChatbubbleFFmpegDelegationFailure; output?: never; }
> {
    job?.life.abort();
    // TODO: Dispatch current progress to the client.
    [job, err] = await FFmpegJob.for(options);
    if (err) return { failure: err };
    return new Promise(resolve => {
        job!.on("success", output => resolve({ output }));
        job!.on("failure", failure => resolve({ failure }));
    });
}

export async function cancelJob(_: IpcMainInvokeEvent): Promise<void> {
    job?.life.abort();
}

export async function isFFmpegSupported(_: IpcMainInvokeEvent): Promise<boolean> {
    const [binary] = await tryGetFfmpegPath();
    return binary !== null;
}


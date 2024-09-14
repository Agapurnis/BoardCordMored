/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ExecException } from "node:child_process";

import { TaggedUnion, UnknownRecord } from "type-fest";

export function assertUnreachable(unreachable?: never, message?: string): never {
    throw new Error(`Unreachable!${message ? ": " + message : String()}`);
}

export interface Dimensions {
    width: number;
    height: number;
}

export interface Rectangle extends Dimensions {
    x: number,
    y: number;
}

export const enum ChatbubbleFFmpegDelegationFailureKind {
    NO_BINARY_AVAILABLE,
    ERROR_FINDING_BINARY,
    BAD_INPUT,
    ENCODING_FAILURE,
    UNKNOWN_ERROR
}


type MapFFmpegDelegationFailureTypes<T extends PropertyKey, R extends UnknownRecord> = TaggedUnion<"type", { [V in T]: R }>;
type FFmpegDelegationFailureVariants =
    | { type: ChatbubbleFFmpegDelegationFailureKind.NO_BINARY_AVAILABLE; }
    | { type: ChatbubbleFFmpegDelegationFailureKind.UNKNOWN_ERROR, error: unknown; }
    | MapFFmpegDelegationFailureTypes<
        | ChatbubbleFFmpegDelegationFailureKind.ERROR_FINDING_BINARY
        | ChatbubbleFFmpegDelegationFailureKind.ENCODING_FAILURE
        | ChatbubbleFFmpegDelegationFailureKind.BAD_INPUT
        , { error: ExecException; }>;

export type ChatbubbleFFmpegDelegationFailure<T extends ChatbubbleFFmpegDelegationFailureKind = ChatbubbleFFmpegDelegationFailureKind>
    = Extract<FFmpegDelegationFailureVariants, { type: T; }>;

type FFmpegTime = [hours: number, minutees: number, seconds: number, fraction: number];

export interface ChatbubbleFFmpegOptions {
    file: {
        name: string,
        mime: string,
        data: Uint8Array;
    };
    target: {
        trim: [start: FFmpegTime | null, end: FFmpegTime | null];
        type: ChatbubbleExportFormat,
        crop?: Rectangle,
        quality?: number;
    };
    overlay: {
        transparent: boolean,
        bounds: Rectangle;
        pixels: Uint8Array,
    };
}


export class ChatbubbleFFmpegTime {
    public static readonly MAGNITUDES = Object.seal([
        1_000_000n, // us => s (thanks ffmpeg)
        60n, // s => m
        60n, // m => h
        24n, // h => d
    ]);

    constructor(public readonly microseconds: bigint) { }

    public toString(): string {
        let time = this.microseconds;
        const parts = new Array<bigint>(ChatbubbleFFmpegTime.MAGNITUDES.length);

        for (let i = 0, j = parts.length - 1; i < parts.length; i++, j--) {
            const magnitude = ChatbubbleFFmpegTime.MAGNITUDES[i];
            const part = time % magnitude;
            parts[j] = (part);
            time /= magnitude;
        }

        if (time !== 0n) throw new Error("Too long!");
        const ms = parts.pop();
        return parts.map(s => String(s ?? 0).padStart(2, "0")).join(":") + "." + String(ms).padStart(2, "0");
    }

    public static parse(input: string): ChatbubbleFFmpegTime {
        let microseconds = 0n;
        const spans = input.match(/\d+/g);
        if (spans === null) throw new Error("Bad time!");
        for (let i = 0, j = ChatbubbleFFmpegTime.MAGNITUDES.length - 1; i < spans.length; i++, j--) {
            microseconds += BigInt(spans[i]);
            microseconds *= ChatbubbleFFmpegTime.MAGNITUDES[j - 1] ?? 1n;
        }
        return new ChatbubbleFFmpegTime(microseconds);
    }
}
export const enum ChatbubbleExportFormat {
    PNG = "image/png",
    GIF = "image/gif",
    MP4 = "video/mp4",
    WEBM = "video/webm",
}

export type ChatbubbleCanvasExportFormat = typeof SUPPORTED_CANVAS_EXPORT_FORMATS extends Set<infer T> ? T : never;
const SUPPORTED_CANVAS_EXPORT_FORMATS = new Set([
    ChatbubbleExportFormat.GIF,
    ChatbubbleExportFormat.PNG
] as const satisfies ReadonlyArray<ChatbubbleExportFormat>);

export function isChatbubbleExportFormatSupportedWithoutFFmpeg<T extends ChatbubbleExportFormat>(format: T): format is Extract<T, ChatbubbleCanvasExportFormat> {
    return SUPPORTED_CANVAS_EXPORT_FORMATS.has(format as ChatbubbleCanvasExportFormat);
}


export namespace ChatbubblePoints {
    type Tuple<T, N extends number, A extends T[] = []> = A["length"] extends N ? A : Tuple<T, N, [...A, T]>;
    export type CoordinateTuple = readonly [x: number, y: number];

    export namespace List {
        export const enum Identifier {
            Bezier = "Bezier",
            Spike = "Spike",
            Crop = "Crop"
        }
        export interface Entries {
            [Identifier.Bezier]: NormalizedPointList<CubicBezier>;
            [Identifier.Spike]: NormalizedPointList<Spike>;
            [Identifier.Crop]: NormalizedPointList<Crop>;
        }

        export type CubicBezier = Tuple<CoordinateTuple, 4>;
        export type Crop = Tuple<CoordinateTuple, 2>;
        export type Spike = Tuple<CoordinateTuple, 3>;
    }

    export class NormalizedPointList<T extends CoordinateTuple[] = CoordinateTuple[]> {
        constructor(public readonly normalized: T) { }
        public inverted({ x = false, y = false }: { x?: boolean, y?: boolean; } = { x: true, y: true }): NormalizedPointList<T> {
            return new NormalizedPointList(this.normalized.map(([vx, vy]) => [
                x ? 1 - vx : vx,
                y ? 1 - vy : vy,
            ] as CoordinateTuple) as T);
        }
        public mul(dimensions: Dimensions): Readonly<{ [N in keyof T]: Readonly<T[N]> }> {
            return this.normalized.map(([x, y]) => [
                x * dimensions.width,
                y * dimensions.height
            ] as const) as Readonly<{ [N in keyof T]: Readonly<T[N]> }>;
        }
        public toSpace(space: Rectangle) {
            return this.normalized.map(([x, y]) => [
                x * space.width + space.x,
                y * space.height + space.y
            ] as const) as Readonly<{ [N in keyof T]: Readonly<T[N]> }>;
        }
    }
}



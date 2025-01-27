/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Upload } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import { CheckedTextInput } from "@components/CheckedTextInput";
import ErrorBoundary from "@components/ErrorBoundary";
import { SpeechIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, openModal, openModalLazy } from "@utils/modal";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByCodeLazy } from "@webpack";
import { Alerts, Button, Forms, lodash, Menu, React, Select, Text, UploadManager, useEffect, useMemo, useRef, useState, zustandCreate } from "@webpack/common";
import { Channel, Message } from "discord-types/general";
import { applyPalette, Encoder, GIFEncoder, quantize } from "gifenc";
import { Flatten } from "ts-pattern/dist/types/helpers";

import { assertUnreachable, ChatbubbleCanvasExportFormat, ChatbubbleExportFormat, ChatbubblePoints, Dimensions, isChatbubbleExportFormatSupportedWithoutFFmpeg, Rectangle } from "./shared";
type CoordinateTuple = ChatbubblePoints.CoordinateTuple;
type NormalizedPointList<T extends CoordinateTuple[] = CoordinateTuple[]> = ChatbubblePoints.NormalizedPointList<T>;
const { NormalizedPointList } = ChatbubblePoints;

type Canvas =
    | HTMLCanvasElement
    | OffscreenCanvas;

type CanvasContext2D =
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;

type StrokeStyle = CanvasContext2D["strokeStyle"];

declare const BRAND: unique symbol;
type Branded<T> = { [BRAND]: T; };
type Brand<T, U> = T & Branded<U>;

namespace Color {
    export const TRANSPARENT = "#000000FF";
    export const BLACK = "#000000";
    export const WHITE = "#FFFFFF";

    export type Hex = `#${string}`;
    export type Packed = Brand<number, "PackedColor">;
    const colorEncodingBuffer = new ArrayBuffer(4);
    const colorEncodingBufferViewU8 = new Uint8Array(colorEncodingBuffer);
    const colorEncodingBufferViewU32 = new Uint32Array(colorEncodingBuffer);
    export function packRGBA(r: number, g: number, b: number, a: number): Packed {
        colorEncodingBufferViewU8[0] = r;
        colorEncodingBufferViewU8[1] = g;
        colorEncodingBufferViewU8[2] = b;
        colorEncodingBufferViewU8[3] = a;
        return colorEncodingBufferViewU32[0] as Packed;
    }
    export function hexToRGBA(r: number, g: number, b: number, a: number): Hex {
        return unpackRGBAIntoHex(packRGBA(r, g, b, a));
    }
    export function packHex(hex: Hex): Packed {
        colorEncodingBufferViewU8[3] = 0; // maybe not present
        for (let i = 1; i <= hex.length - 1; i += 2) {
            colorEncodingBufferViewU8[i] = Number.parseInt(hex.slice(i, i + 2), 16);
        }
        return colorEncodingBufferViewU32[0] as Packed;
    }
    export function unpackRGBAIntoHex(encoded: Packed): Hex {
        return "#" + encoded.toString(16) as Hex;
    }
}

const logger = new Logger("ChatBubblification");

const ActionBarIcon = findByCodeLazy(".actionBarIcon)");
const Native = VencordNative.pluginHelpers.ChatBubblification as PluginNative<typeof import("./native")>;

const cl = classNameFactory("vc-cb-");

function ReactWrapHTML(type: string, props: Record<string, unknown>, children: HTMLElement[]) {
    return React.createElement(type, {
        ...props,
        ref: (element: HTMLElement) => {
            element?.append(...children);
        }
    });
}

type SupportedMediaElement =
    | HTMLImageElement
    | HTMLVideoElement;

function getNaturalDimensions(element: SupportedMediaElement): Dimensions {
    if (element instanceof HTMLImageElement) {
        return {
            width: element.naturalWidth,
            height: element.naturalHeight,
        };
    } else {
        if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
            throw new Error("Dimensions cannot be retrieved; relevant metadata has not yet arrived.");
        }

        return {
            width: element.videoWidth,
            height: element.videoHeight
        };
    }
}

function getClientDimensions(element: HTMLElement): Dimensions {
    return {
        width: element.clientWidth,
        height: element.clientHeight,
    };
}

function roundSpacial<T extends Dimensions | Rectangle>(spacial: T, round: (n: number) => number = Math.round, clone = [Object, null].includes(Reflect.getPrototypeOf(spacial) as any)): T {
    if (clone) spacial = lodash.pick(spacial, "x", "y", "width", "height") as T;
    if ("x" in spacial) {
        spacial.x = round(spacial.x);
        spacial.y = round(spacial.y);
    }
    spacial.width = round(spacial.width);
    spacial.height = round(spacial.height);
    return spacial;
}

function divideSpacial<T extends Dimensions | Rectangle>(left: T, right: Dimensions, clone: boolean): T {
    if (clone) left = lodash.pick(left, "x", "y", "width", "height") as T;
    left.width /= right.width;
    left.height /= right.height;
    if ("x" in left) {
        left.x /= right.width;
        left.y /= right.height;
    }
    return left;
}
function multiplySpacial<T extends Dimensions | Rectangle>(left: T, scalar: number, clone: boolean): T {
    if (clone) left = lodash.pick(left, "x", "y", "width", "height") as T;
    left.width *= scalar;
    left.height *= scalar;
    if ("x" in left) {
        left.x *= scalar;
        left.y *= scalar;
    }
    return left;
}
function unitSpacial<T extends Dimensions | Rectangle>(spacial: T, clone: boolean): T {
    if (clone) spacial = lodash.pick(spacial, "x", "y", "width", "height") as T;
    if ("x" in spacial) {
        spacial.x /= spacial.width;
        spacial.y /= spacial.height;
    }
    if (spacial.height > spacial.width) {
        spacial.height = 1;
        spacial.width /= spacial.height;
    } else {
        spacial.height /= spacial.width;
        spacial.width = 1;
    }
    return spacial;
}


function load<T extends
    | HTMLImageElement
    | HTMLVideoElement
>(type: new () => T, from: Blob | MediaSource, { autoRevoke = true } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const url = URL.createObjectURL(from);
        const media = document.createElement((type === HTMLImageElement) ? "img" : "video") as T;
        media.onerror = event => {
            URL.revokeObjectURL(url);
            reject(new Error("Could not load", { cause: event }));
        };
        media.onload = () => {
            if (autoRevoke) URL.revokeObjectURL(url);
            resolve(media);
        };
        media.onloadeddata = () => {
            if (autoRevoke) URL.revokeObjectURL(url);
            resolve(media);
        };
        if (type === HTMLVideoElement) {
            (media as HTMLVideoElement).defaultMuted = true;
            (media as HTMLVideoElement).muted = true;
            (media as HTMLVideoElement).autoplay = true;
            (media as HTMLVideoElement).loop = true;
        }
        media.src = url;
    });
}

function makeCanvas(dimensions: Dimensions, type: typeof OffscreenCanvas): { canvas: OffscreenCanvas, context: OffscreenCanvasRenderingContext2D; };
function makeCanvas(dimensions: Dimensions, type: typeof HTMLCanvasElement): { canvas: HTMLCanvasElement, context: CanvasRenderingContext2D; };
function makeCanvas({ width, height }: Dimensions, type: typeof OffscreenCanvas | typeof HTMLCanvasElement): { canvas: Canvas, context: CanvasContext2D; } {
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (type === OffscreenCanvas) {
        canvas = new OffscreenCanvas(width, height);
    } else {
        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.classList.add(cl("contain"));
        canvas.classList.add(cl("contain-force"));
    }
    const context = canvas.getContext("2d") as CanvasContext2D;
    if (!context) throw new Error("Could not get 2D canvas rendering context!");
    return { canvas, context };
}

function ChatBubbleContextMenuItem({ url, mime, channel }: { url: string, mime?: string, channel: Channel; }) {
    return (
        <Menu.MenuItem
            icon={SpeechIcon}
            label="Chatbubble-ify"
            key="chatbubble-prompt"
            id="chatbubble-prompt"
            action={async () => {
                const fetched = await fetch(url, {
                    headers: mime?.startsWith("video") ? { "range": "bytes=0-" } : undefined,
                });

                const modified = fetched.headers.get("last-modified"); // todo: get name
                const file = new File([await fetched.blob()], "media", {
                    lastModified: modified ? Number(new Date(modified)) : Date.now(),
                    type: fetched.headers.get("content-type") ?? mime
                });

                const chatbubble = await Chatbubble.forFile(file);
                openModal(props => <EditorModal
                    modal={props}
                    chatbubble={chatbubble}
                    close={async save => {
                        props.onClose();
                        if (save) {
                            const file = await chatbubble.export("bubble");
                            chatbubble.persistUnderAssociatedFile(file);
                            UploadManager.addFile({
                                channelId: channel.id,
                                draftType: 0,
                                showLargeMessageDialog: false,
                                file: {
                                    file,
                                    isThumbnail: false,
                                    platform: 1
                                }
                            });
                        } else {
                            chatbubble.release();
                        }
                    }}
                />);
            }}
        />
    );
}


interface MessageContextMenuMediaItem {
    contentType: string,
    proxyUrl: string,
    url: string;
}

interface MessageContextMenuProperties {
    message: Message,
    channel: Channel,
    itemSafeSrc?: string,
    mediaItem: MessageContextMenuMediaItem | undefined;
}

const messageAttachmentContextMenu: NavContextMenuPatchCallback = (children: Array<React.ReactElement | null>, props: MessageContextMenuProperties) => {
    const url = props.itemSafeSrc; if (!url) return;
    const mime = props.mediaItem?.contentType;
    const group = findGroupChildrenByChildId("copy-link", children);
    group?.push(ChatBubbleContextMenuItem({ url, mime, channel: props.channel }));
};

export default definePlugin({
    name: "ChatBubblification",
    description: "Convert attachments into chatbubbles of various shapes and sizes.",
    authors: [Devs.katini],
    settings: definePluginSettings({
        showInContextMenu: {
            type: OptionType.BOOLEAN,
            default: true,
            description: "Show an icon for toggling the plugin",
            restartNeeded: true,
        }
    }),
    patches: [
        {
            // TODO: maybe make an api for this?
            // TODO: Stole this from the anonymize image thing and it conflicts with that
            find: ".Messages.ATTACHMENT_UTILITIES_SPOILER",
            replacement: {
                match: /(?<=children:\[)(?=.{10,80}tooltip:.{0,100}\i\.\i\.Messages\.ATTACHMENT_UTILITIES_SPOILER)/,
                replace: "arguments[0].canEdit!==false?$self.renderIcon(arguments[0]):null,"
            },
        },
        {
            // Adapted from from the reverseImageSearch plugin :)
            find: ".Messages.MESSAGE_ACTIONS_MENU_LABEL,shouldHideMediaOptions",
            replacement: {
                match: /favoriteableType:\i,(?<=(\i)\.getAttribute\("data-type"\).+?)/,
                replace: (m, target) => `${m}actionsTarget:${target},`
            }
        },
        {
            find: "Messages.ATTACHMENT_UTILITIES_REMOVE",
            replacement: {
                // resilient but unoptimized, 0.3ms :/ plsfix
                match: /(?<=ATTACHMENT_UTILITIES_REMOVE.*=>)(.*?)((?:\i|\.)*remove\((?:.*?(\i|\.)+\.id)[^)]*\))/,
                replace: "$1(()=>{$self.deregisterUpload($3);return $2})()"
            }
        }
    ],

    deregisterUpload({ item: { file } }: Upload | { item: { file: File; }; }) {
        const chatbubble = Chatbubble.fileMapped.get(file);
        if (chatbubble) {
            chatbubble.release();
            Chatbubble.fileMapped.delete(file);
        }
        // -patch -GatewaySocket -cookie -find -mapMangled -start -registering -subscribing -RPCServer -preload -violation -content-security-policy
    },

    renderIcon(wrapped: { upload: Upload; }) {
        return <ErrorBoundary noop wrappedProps={wrapped}>
            <ActionBarIcon
                tooltip={"Chatbubble-ify!"}
                onClick={() => openModalLazy(async () => {
                    const chatbubble = await Chatbubble.forFile(wrapped.upload.item.file);
                    return props => <EditorModal
                        modal={props}
                        chatbubble={chatbubble}
                        close={async save => {
                            props.onClose();
                            if (save) {
                                const file = await chatbubble.export(wrapped.upload.item.file.name);
                                chatbubble.persistUnderAssociatedFile(file);
                                UploadManager.setFile({
                                    file: {
                                        file,
                                        isThumbnail: false,
                                        platform: 1
                                    },
                                    channelId: (wrapped.upload as unknown as { channelId: string; }).channelId,
                                    id: wrapped.upload.id,
                                    draftType: 0,
                                });
                            }
                        }}
                    />;
                })}
            >
                <Vencord.Components.SpeechIcon />
            </ActionBarIcon>
        </ErrorBoundary>;
    },

    contextMenus: {
        "message": messageAttachmentContextMenu,
    }
});


class LazyDirtyable<T> {
    constructor(protected readonly compute: () => T) { }
    public mark() {
        this.dirty = true;
    }
    protected dirty = true;
    protected value: T | null = null;
    public get(): T {
        if (this.dirty) this.value = this.compute();
        return this.value!;
    }
}


const TRANSPARENT_CHECKERBOARD_LIGHT = "#EDEDED";
const TRANSPARENT_CHECKERBOARD_DARK = "#FFFFFF";
function makeCheckerboardTransparencyPattern(size: number) {
    const { canvas, context } = makeCanvas({ width: size, height: size }, OffscreenCanvas);
    const half = size / 2;
    context.fillStyle = TRANSPARENT_CHECKERBOARD_LIGHT;
    context.fillRect(0, 0, size, size);
    context.fillStyle = TRANSPARENT_CHECKERBOARD_DARK;
    context.fillRect(0, 0, half, half);
    context.fillRect(half, half, half, half);
    return canvas;
}



const enum DrawingMode {
    Preview = 1,
    Final
}

class ChatbubbleCanvasRenderer implements CanvasRenderingEnvironment {
    public clear() {
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    public drawImage() {
        if (!(this.configuration.source instanceof HTMLImageElement)) throw new Error("Can only use `drawImage` with image sources!");
        this.context.globalCompositeOperation = "source-over";
        const { x, y } = this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution);
        this.context.drawImage(this.configuration.source,
            x, y, this.canvas.width, this.canvas.height,
            0, 0, this.canvas.width, this.canvas.height
        );
    }

    public drawBubbleStroke(path: Path2D) {
        this.context.globalAlpha = 1;
        this.context.globalCompositeOperation = "source-over";
        this.context.lineWidth = this.configuration.stroke.width;
        this.context.strokeStyle = this.configuration.stroke.color;
        this.context.stroke(path);
    }

    public drawBubble({ stroke: strokeForceDisable }: { stroke?: false; } = {}): Path2D {
        const transparent = this.configuration.fill === Color.TRANSPARENT;
        const offscreen = this.mergeOffscreen.getContext("2d")!;
        offscreen.clearRect(0, 0, offscreen.canvas.width, offscreen.canvas.height);

        const path = new Path2D();
        const space = this.getOffsetCanvasSpace();
        const shapes = this.configuration.shapes.getState().list;

        offscreen.fillStyle = transparent
            ? (this.mode === DrawingMode.Final)
                ? Color.BLACK
                : this.transparencyPattern.get()
            : this.configuration.fill;

        for (const shape of shapes) {
            if (!(shape instanceof AbstractDrawnPathedShape)) {
                throw new Error("Unsupported shape! :c");
            }
            shape.draw(offscreen, space, { fill: true });
            path.addPath(shape.getPath(space));
        }

        const { stroke } = this.configuration;
        const doDrawStroke = (strokeForceDisable === false) && stroke.color !== Color.TRANSPARENT && stroke.width > 0;
        if (doDrawStroke) this.drawBubbleStroke(path);
        if (transparent) {
            if (this.mode === DrawingMode.Final) {
                this.context.globalCompositeOperation = "destination-out";
            } else {
                if (doDrawStroke) {
                    this.context.globalAlpha = 1;
                    this.context.globalCompositeOperation = "destination-out";
                    this.context.drawImage(offscreen.canvas, 0, 0);
                }

                this.context.globalCompositeOperation = "screen";
                this.context.globalAlpha = 0.8;
            }
        }
        this.context.drawImage(offscreen.canvas, 0, 0);
        if (transparent) {
            this.context.globalCompositeOperation = "source-over";
            this.context.globalAlpha = 1;
        }

        if (this.mode === DrawingMode.Preview) {
            for (const shape of shapes) {
                shape.draw(this.context, space, { stroke: "#00FF00", lineWidth: 3 });
                if (shape instanceof DrawnBezierCurve) {
                    shape.drawControlLines(this.context, space, { stroke: "blue" });
                }
            }
        }

        return path;
    }

    protected exportGIF(): Encoder {
        const gif = GIFEncoder();
        this.configuration.removeCropClip();
        const { data, width, height } = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
        this.configuration.updateCropClip();
        const palette = quantize(data, 256, { format: "rgba4444", });
        const index = applyPalette(data, palette, "rgba4444");
        gif.writeFrame(index, width, height, { transparent: true, palette, });
        gif.finish();
        return gif;
    }

    protected async exportPNG(quality?: number): Promise<Blob> {
        const { canvas } = this;
        if (canvas instanceof OffscreenCanvas) {
            return canvas.convertToBlob({
                quality,
                type: "image/png"
            });
        } else {
            return new Promise(resolve => canvas.toBlob(blob => {
                if (!blob) throw new Error("Could not export!");
                resolve(blob);
            }, "image/png", quality));
        }
    }

    public async export(filename: string, format: ChatbubbleCanvasExportFormat, quality?: number): Promise<File> {
        let contents: BlobPart[];
        let extension: string;
        switch (format) {
            case ChatbubbleExportFormat.GIF: {
                contents = [this.exportGIF().bytesView()];
                extension = "gif";
                break;
            }
            case ChatbubbleExportFormat.PNG: {
                contents = [await this.exportPNG(quality)];
                extension = "png";
                break;
            }
            default: assertUnreachable(format, "format not handled");
        }
        return new File(contents, filename + "." + extension, {
            lastModified: Date.now(),
            type: format,
        });
    }

    public resize(dimensions: Dimensions) {
        if (
            dimensions.width === 0 ||
            dimensions.height === 0
        ) return;
        this.canvas.width = dimensions.width;
        this.canvas.height = dimensions.height;
        this.mergeOffscreen.width = dimensions.width;
        this.mergeOffscreen.height = dimensions.height;
    }

    public getOffsetCanvasSpace(): Rectangle {
        switch (this.mode) {
            case DrawingMode.Preview: {
                const { width, height } = this.canvas;
                return { width, height, x: 0, y: 0 };
            }
            case DrawingMode.Final: {
                const { width, height } = this.configuration.uncroppedResolution;
                const { x, y } = this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution);
                return { width, height, x: -x, y: -y };
            }
            default: assertUnreachable(this.mode);
        }
    }

    protected readonly transparencyPattern = new LazyDirtyable(() => {
        const checkerboard = makeCheckerboardTransparencyPattern(20);
        return this.context.createPattern(checkerboard, "repeat")!;
    });

    protected mergeOffscreen: OffscreenCanvas;

    public get canvas(): Canvas {
        return this.context.canvas;
    }

    constructor(
        public readonly configuration: ChatbubbleConfiguration,
        protected readonly mode: DrawingMode,
        public readonly context: CanvasContext2D,
    ) {
        this.mergeOffscreen = new OffscreenCanvas(this.canvas.width, this.canvas.height);
    }
}

class ChatbubbleConfiguration {
    public static async forFile(file: File) {
        type MediaConstructor = new () => ConstructorParameters<typeof ChatbubbleConfiguration>[1];
        const media = await load((file.type.startsWith("image")
            ? HTMLImageElement
            : HTMLVideoElement
        ) as MediaConstructor, file, { autoRevoke: false });
        media.classList.add(cl("contain"), cl("contain-force"));
        return new ChatbubbleConfiguration(file, media);
    }

    public readonly uncroppedResolution: Readonly<Dimensions>;
    constructor(
        public readonly file: File,
        public readonly source: HTMLImageElement | HTMLVideoElement,
    ) {
        this.uncroppedResolution = Object.seal(getNaturalDimensions(source));
    }

    public removeCropClip() {
        this.source.style.clipPath = String();
    }

    public updateCropClip() {
        const { x, y, width, height } = this.getCroppedRectangle({ width: 1, height: 1 });
        this.source.style.clipPath = "xywh(" + [x, y, width, height].map(n => (n * 100) + "%").join(" ") + ")";
    }

    public getCroppedRectangle(scale: Dimensions): Rectangle;
    public getCroppedRectangle(space: Rectangle): Rectangle;
    public getCroppedRectangle(space: Rectangle | Dimensions) {
        const { corners } = this.crop.getState();
        const [a, b] = "x" in space ? corners.toSpace(space) : corners.mul(space);
        const [xlo, xhi] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]]; const w = xhi - xlo;
        const [ylo, yhi] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]]; const h = yhi - ylo;
        return {
            x: xlo,
            y: ylo,
            width: w,
            height: h,
        };
    }


    public stroke: { color: Color.Hex, width: number; } = { color: Color.BLACK, width: 0 };
    public fill = Color.TRANSPARENT;
    public format = ChatbubbleExportFormat.GIF;
    public readonly crop = zustandCreate<CropStore>((set, get) => ({
        corners: new NormalizedPointList([[0, 0], [1, 1]]),
        editing: null,
    }));
    public readonly shapes = zustandCreate<ShapesStore>((set, get) => {
        return {
            selected: new Set(),
            list: [
                new DrawnBezierCurve(new NormalizedPointList([[0, 0], [.25, .4], [0.75, .4], [1, 0]])),
                new DrawnPolygon<3>(new NormalizedPointList([[.25, 0], [.5, .5], [.75, 0]]))
            ],

            invert(details) {
                set({
                    list: get().list.map(shape => {
                        if (shape instanceof DrawnPolygon) {
                            shape.normalizedPoints = shape.normalizedPoints.inverted(details);
                        } else {
                            throw new Error("Inversion operation is unimplemented for the provided shape!");
                        }
                        return shape;
                    })
                });
            },

            move(shapeIndex, amount) {
                const old = get();
                const shape = old.list[shapeIndex] as DrawnPolygon;
                const clone = shape.cloneShallow();
                clone.normalizedPoints = new NormalizedPointList(shape.normalizedPoints.normalized.map(point => [
                    (point as [number, number])[0] + amount[0],
                    (point as [number, number])[1] + amount[1]
                ]));
                set({ list: old.list.with(shapeIndex, clone) });
            }
        };
    });
}

interface ShapesStore {
    selected: Set<number>, // shape indices
    list: AbstractDrawnShape[],

    invert(details: Parameters<NormalizedPointList["inverted"]>[0]): void;
    move(shapeIndex: number, amount: CoordinateTuple): void;
}

interface CropStore {
    corners: NormalizedPointList<[tl: CoordinateTuple, br: CoordinateTuple]>,
    editing: Corner | null,
}


class Chatbubble {
    public static readonly fileMapped = new Map<File, Chatbubble>();
    public static async forFile(file: File) {
        const existing = Chatbubble.fileMapped.get(file);
        if (existing) return existing;
        const chatbubble = new Chatbubble(await ChatbubbleConfiguration.forFile(file));
        Chatbubble.fileMapped.set(file, chatbubble);
        return chatbubble;
    }

    private associatedFile: File;
    public persistUnderAssociatedFile(file: File) {
        Chatbubble.fileMapped.delete(this.associatedFile);
        Chatbubble.fileMapped.set(file, this);
        this.associatedFile = file;
    }

    public readonly preview: ChatbubbleCanvasRenderer;

    constructor(
        public readonly configuration: ChatbubbleConfiguration
    ) {
        this.associatedFile = configuration.file;
        const dimensions = getNaturalDimensions(this.configuration.source);
        const preview = makeCanvas(dimensions, HTMLCanvasElement);
        this.preview = new ChatbubbleCanvasRenderer(configuration, DrawingMode.Preview, preview.context);
        this.updateCropClip();
    }

    public updateCropClip() {
        this.configuration.updateCropClip();
    }

    public release() {
        URL.revokeObjectURL(this.configuration.source.src);
        Chatbubble.fileMapped.delete(this.associatedFile);
    }

    public async export(filename: string, format: ChatbubbleExportFormat = this.configuration.format, quality?: number): Promise<File> {
        const hasFFmpeg = await Native.isFFmpegSupported();
        const needsFFmpeg = !isChatbubbleExportFormatSupportedWithoutFFmpeg(format) || this.configuration.file.type.startsWith("video");

        if (!needsFFmpeg && !(hasFFmpeg && format === ChatbubbleExportFormat.GIF)) {
            const offscreen = makeCanvas(this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution), OffscreenCanvas);
            const renderer = new ChatbubbleCanvasRenderer(this.configuration, DrawingMode.Final, offscreen.context);
            renderer.drawImage();
            renderer.drawBubble();
            return renderer.export(filename, format, quality);
        }

        // TODO: the path thing does'nt work if i don't launch it from terminal
        // maybe spawn a shell itself? ahaha. or pwd or something (no, that wouldn't be it.,,, idk)
        if (!hasFFmpeg) {
            // TODO: UI for errors
            alert("ermmm,,,, ffmpeg pls");
            throw new Error("ff-mpreg!!!!");
        }


        const transparent = this.configuration.fill === Color.TRANSPARENT;
        const bubble = (() => {
            const bounds = roundSpacial(this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution), Math.trunc);
            const offscreen = makeCanvas(bounds, OffscreenCanvas);
            const renderer = new ChatbubbleCanvasRenderer(this.configuration, DrawingMode.Final, offscreen.context);
            if (transparent && (format.toString().startsWith("video") || format === ChatbubbleExportFormat.GIF)) {
                renderer.context.globalCompositeOperation = "source-over";
                renderer.context.fillStyle = Color.BLACK;
                renderer.context.fillRect(0, 0, renderer.canvas.width, renderer.canvas.height);
            }
            renderer.drawBubble();
            const pixels = new Uint8Array(renderer.context.getImageData(0, 0, offscreen.canvas.width, offscreen.canvas.height).data);
            return { pixels, bounds };
        })();

        const { output, failure } = await Native.ffmpeg({
            file: {
                mime: this.configuration.file.type,
                data: new Uint8Array(await this.configuration.file.arrayBuffer()),
            },
            target: {
                crop: roundSpacial(this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution), Math.trunc),
                type: format
            },
            overlay: {
                transparent,
                ...bubble
            }
        });

        if (failure) throw failure;

        const extension = format.slice(format.indexOf("/") + 1);
        return new File([output], filename + "." + extension, {
            lastModified: Date.now(),
            type: format,
        });
    }
}

function EditorModal({ modal, close, chatbubble }: {
    modal: ModalProps,
    close: (save: boolean) => void,
    chatbubble: Chatbubble;
}) {
    return <ErrorBoundary>
        <ModalRoot {...modal} className={cl("editor-modal")}>
            <ModalHeader className={cl("editor-header")}>
                <Text variant="heading-lg/semibold">
                    Bubble Editor
                </Text>
                <ModalCloseButton onClick={() => {
                    Alerts.show({
                        title: "Are you sure?",
                        body: "Exiting without saving will discard all changes.",
                        onConfirm: () => close(false),
                        confirmText: "Confirm",
                        cancelText: "Cancel"
                    });
                }} />
            </ModalHeader>

            <ModalContent className={cl("editor-modal-content")}>
                <React.Suspense>
                    <ChatbubbleEditor chatbubble={chatbubble} />
                </React.Suspense>
            </ModalContent>

            <ModalFooter>
                <ChatbubbleEditorFooter
                    close={close}
                    chatbubble={chatbubble}
                />
            </ModalFooter>
        </ModalRoot>
    </ErrorBoundary >;
}

function useOnSizeChange(element: HTMLElement, callback: (entry: ResizeObserverEntry, dimensionChange: boolean) => void) {
    const last: Dimensions = { height: element.clientHeight, width: element.clientWidth };
    const observer = new ResizeObserver(([entry]) => {
        const changed = last.height !== element.clientHeight || last.width !== element.clientWidth;
        last.height = element.clientHeight;
        last.width = element.clientWidth;
        callback(entry, changed);
    });
    observer.observe(element);
    useEffect(() => () => observer.disconnect());
}

function getContainFit(element: SupportedMediaElement, natural = getNaturalDimensions(element)): Rectangle & { scale: number; } {
    const naturalAR = natural.width / natural.height;
    const containAR = element.clientWidth / element.clientHeight;

    let scale: number;
    let width: number;
    let height: number;
    if (naturalAR > containAR) {
        width = element.clientWidth;
        height = element.clientWidth / naturalAR;
        scale = element.clientWidth / natural.width;
    } else {
        width = element.clientHeight * naturalAR;
        height = element.clientHeight;
        scale = element.clientHeight / natural.height;
    }

    const x = (element.clientWidth - width) / 2;
    const y = (element.clientHeight - height) / 2;
    return { width, height, x, y, scale };
}

function ChatbubbleEditor({ chatbubble }: { chatbubble: Chatbubble; }) {
    const { configuration: { source, uncroppedResolution: resolution }, preview } = chatbubble;

    const dimmed = useMemo(() => {
        const dimmed = source.cloneNode() as HTMLImageElement;
        dimmed.classList.add(cl("crop-dimmed"));
        return dimmed;
    }, [source]);


    preview.resize(source);
    useOnSizeChange(source, (_, changed) => {
        if (!changed) return;
        preview.resize(source);
        draw();
    });

    function draw() {
        preview.clear();
        preview.drawBubble();
    }

    draw();
    return <div className={cl("editor", "contain-force")}>
        <SelectionDetector chatbubble={chatbubble} draw={draw} />
        <ImageSizedContainer dimensions={resolution}>
            {ReactWrapHTML("div", { style: { display: "contents " } }, [dimmed, source, preview.canvas as HTMLCanvasElement])}
        </ImageSizedContainer>
        <CropControls chatbubble={chatbubble} />
        <ShapeHandles chatbubble={chatbubble} draw={draw} />
    </div>;
}

function SelectionDetector({ chatbubble, draw }: { chatbubble: Chatbubble; draw: () => void; }) {
    const self = React.createRef<HTMLDivElement>();
    const shapes = chatbubble.configuration.shapes.getState();
    const uncropped = chatbubble.configuration.uncroppedResolution;
    let last: MouseEvent | null = null;

    function updatePosition(event: MouseEvent) {
        if (!self.current) return null;
        const origin = self.current.getBoundingClientRect();
        const x = (event.clientX - last!.clientX) / origin.width;
        const y = (event.clientY - last!.clientY) / origin.height;
        const adjust = [x, y] as const;
        for (const index of shapes.selected) {
            shapes.move(index, adjust);
        }
        last = event;
        draw();
    }

    function getHovered(event: MouseEvent): number | null {
        if (!self.current) return null;
        const origin = self.current.getBoundingClientRect();
        const x = (event.pageX - origin.x);
        const y = (event.pageY - origin.y);
        const position = [x, y] as const;
        const index = chatbubble.configuration.shapes.getState().list.findLastIndex(shape => {
            if (shape.testPoint(chatbubble.preview.context, {
                x: 0, y: 0,
                width: origin.width,
                height: origin.height
            }, position)) {
                return true;
            }
        });
        if (index === -1) return null;
        return index;
    }

    return <div
        ref={self}
        style={{ "aspectRatio": uncropped.width + "/" + uncropped.height }}
        className={cl("editor-selector", "contain-force")}
        onMouseDown={event => {
            // TODO: context menu to move down/up layer on right click?
            const hovered = getHovered(event as never);
            if (hovered === null) { shapes.selected.clear(); return; }
            shapes.selected.add(hovered);
            document.addEventListener("mouseup", () => {
                document.removeEventListener("mousemove", updatePosition);
                shapes.selected.clear();
            }, { once: true });
            document.addEventListener("mousemove", updatePosition);
            last = event.nativeEvent;
        }}
    />;
}

function CropControls({ chatbubble }: { chatbubble: Chatbubble; }) {
    return <ImageSizedContainer data-handle-controls="crop" dimensions={chatbubble.configuration.uncroppedResolution}>
        <CropBorderOverlay chatbubble={chatbubble} />
        {[Corner.TOP_LEFT, Corner.TOP_RIGHT, Corner.BOTTOM_RIGHT, Corner.BOTTOM_LEFT].map(corner => {
            return <CornerCropHandle chatbubble={chatbubble} corner={corner} />;
        })}
    </ImageSizedContainer>;
}

function CropBorderOverlay({ chatbubble }: { chatbubble: Chatbubble; }) {
    const ref = useRef<HTMLDivElement | null>(null);
    function resetStyledBox() {
        if (!ref.current) return;
        const { x, y, width, height } = chatbubble.configuration.getCroppedRectangle(lodash.pick(chatbubble.configuration.source, "width", "height"));
        ref.current.style.left = `${x}px`;
        ref.current.style.top = `${y}px`;
        ref.current.style.width = `${width}px`;
        ref.current.style.height = `${height}px`;
    }
    useEffect(() => chatbubble.configuration.crop.subscribe(resetStyledBox), []);
    useOnSizeChange(chatbubble.configuration.source, resetStyledBox);
    return <div className={cl("editor-crop-outline")} ref={ref} />;
}

const enum Corner {
    TOP_LEFT = 0,
    TOP_RIGHT = 1,
    BOTTOM_RIGHT = 2,
    BOTTOM_LEFT = 3
}

const CORNER_CROP_HANDLE_STROKE_LENGTH = 15;
const CORNER_CROP_HANDLE_STROKE_WIDTH = 3;
const CORNER_CROP_HANDLE_PAD = 4;
function CornerCropHandle({ chatbubble, corner }: { chatbubble: Chatbubble; corner: Corner; }) {
    let reprSizeX!: number;
    let reprSizeY!: number;
    function calculateNormalizedSizeRepresentation() {
        const { width, height } = getClientDimensions(chatbubble.configuration.source);
        reprSizeX = (CORNER_CROP_HANDLE_STROKE_LENGTH) / width;
        reprSizeY = (CORNER_CROP_HANDLE_STROKE_LENGTH) / height;
    }
    calculateNormalizedSizeRepresentation();

    const top = corner < 2;
    const left = (corner % 2 === 0) === top;

    function normalizedPositionFromState(store: CropStore, applyShift = true) {
        calculateNormalizedSizeRepresentation();
        const { corners: { normalized } } = store;
        return [
            left ? normalized[0][0] : normalized[1][0] - reprSizeX,
            top ? normalized[0][1] : normalized[1][1] - reprSizeY,
        ] as CoordinateTuple;
    }

    function getCanonicalNormalizedPosition() {
        return normalizedPositionFromState(chatbubble.configuration.crop.getState(), true);
    }

    const ref = useRef<HTMLDivElement | null>(null);

    const [position, setPosition] = useState<CoordinateTuple>(getCanonicalNormalizedPosition());

    useOnSizeChange(chatbubble.preview.canvas as HTMLElement, () => {
        const difference = getCanonicalNormalizedPosition();
        if (difference.some((value, index) => position[index] !== value)) {
            setPosition(difference);
            chatbubble.updateCropClip();
        }
    });

    useEffect(() => chatbubble.configuration.crop.subscribe(state => {
        if (state.editing === corner) return;
        setPosition(normalizedPositionFromState(state, true));
        chatbubble.updateCropClip();
    }));

    const tx = -CORNER_CROP_HANDLE_PAD + CORNER_CROP_HANDLE_STROKE_WIDTH * (left ? -1 : 1);
    const ty = -CORNER_CROP_HANDLE_PAD + CORNER_CROP_HANDLE_STROKE_WIDTH * (top ? -1 : 1);

    useDraggability({
        normalize: true,
        position,
        clamp: [[0, 1 - reprSizeX], [0, 1 - reprSizeY]],
        offset: [-tx, -ty],
        ref,
        onPointerDown() {
            chatbubble.configuration.crop.setState({ editing: corner });
        },
        onPointerUp() {
            chatbubble.configuration.crop.setState({ editing: null });
        },
        onPointerMove(position) {
            const corners = chatbubble.configuration.crop.getState().corners.clone();
            switch (corner) {
                case Corner.TOP_LEFT:
                    (corners.normalized[0] as [number, number])[0] = position[0];
                    (corners.normalized[0] as [number, number])[1] = position[1];
                    break;
                case Corner.TOP_RIGHT:
                    (corners.normalized[0] as [number, number])[1] = position[1];
                    (corners.normalized[1] as [number, number])[0] = position[0] + reprSizeX;
                    break;
                case Corner.BOTTOM_RIGHT:
                    (corners.normalized[1] as [number, number])[0] = position[0] + reprSizeX;
                    (corners.normalized[1] as [number, number])[1] = position[1] + reprSizeY;
                    break;
                case Corner.BOTTOM_LEFT:
                    (corners.normalized[0] as [number, number])[0] = position[0];
                    (corners.normalized[1] as [number, number])[1] = position[1] + reprSizeY;
                    break;
            }
            chatbubble.configuration.crop.setState({ corners });
        },
    });

    return <div
        ref={ref}
        className={cl("editor-crop-handle")}
    >
        <svg
            width={CORNER_CROP_HANDLE_STROKE_LENGTH + CORNER_CROP_HANDLE_PAD * 2}
            height={CORNER_CROP_HANDLE_STROKE_LENGTH + CORNER_CROP_HANDLE_PAD * 2}
            transform={`translate(${tx}, ${ty})`}
        >
            {/* math here is probably incorrect (esp the random 1.5) but who fuck care */}
            <rect className={cl("hitbox-expanded")} fill="transparent" x={0} y={top ? 0 : (CORNER_CROP_HANDLE_STROKE_LENGTH + CORNER_CROP_HANDLE_STROKE_WIDTH) - CORNER_CROP_HANDLE_PAD * 1.5} width={CORNER_CROP_HANDLE_STROKE_LENGTH + CORNER_CROP_HANDLE_PAD * 2} height={CORNER_CROP_HANDLE_STROKE_WIDTH + CORNER_CROP_HANDLE_PAD * 2} />
            <rect className={cl("hitbox-expanded")} fill="transparent" y={0} x={left ? 0 : (CORNER_CROP_HANDLE_STROKE_LENGTH + CORNER_CROP_HANDLE_STROKE_WIDTH) - CORNER_CROP_HANDLE_PAD * 1.5} width={CORNER_CROP_HANDLE_STROKE_WIDTH + CORNER_CROP_HANDLE_PAD * 2} height={CORNER_CROP_HANDLE_STROKE_LENGTH + CORNER_CROP_HANDLE_PAD * 2} />
            <rect fill="white" x={CORNER_CROP_HANDLE_PAD} y={CORNER_CROP_HANDLE_PAD + (top ? 0 : CORNER_CROP_HANDLE_STROKE_LENGTH - CORNER_CROP_HANDLE_STROKE_WIDTH)} width={CORNER_CROP_HANDLE_STROKE_LENGTH} height={CORNER_CROP_HANDLE_STROKE_WIDTH} />
            <rect fill="white" y={CORNER_CROP_HANDLE_PAD} x={CORNER_CROP_HANDLE_PAD + (left ? 0 : CORNER_CROP_HANDLE_STROKE_LENGTH - CORNER_CROP_HANDLE_STROKE_WIDTH)} width={CORNER_CROP_HANDLE_STROKE_WIDTH} height={CORNER_CROP_HANDLE_STROKE_LENGTH} />
        </svg>
    </div >;
}

function ShapeHandles({ chatbubble, draw }: { chatbubble: Chatbubble; draw: () => void; }) {
    return chatbubble.configuration.shapes(shapes => shapes.list.map((shape, index) => {
        if (shape instanceof AbstractDrawnPathedShape) {
            return <ShapePointsHandles
                shape={shape}
                chatbubble={chatbubble}
                onChange={draw}
            />;
        } else {
            throw new Error("No handle implementation for given shape!");
        }
    }));
}

function ShapePointsHandles({ chatbubble, shape, onChange }: { chatbubble: Chatbubble, shape: AbstractDrawnPathedShape, onChange: () => void; }) {
    return <Points
        color={shape instanceof DrawnBezierCurve ? "blue" : "red"}
        onChange={onChange}
        dimensions={chatbubble.configuration.uncroppedResolution}
        clamp={false}
        points={shape.getNormalizedPoints()}
    />;
}

function ChatbubbleEditorFooter({ close, chatbubble }: {
    close: (save: boolean) => void,
    chatbubble: Chatbubble;
}) {
    const [format, setFormat] = useState(chatbubble.configuration.format);
    useEffect(() => { chatbubble.configuration.format = format; }, [format]);
    const [strokeStyle, setStrokeStyle] = useState(chatbubble.configuration.stroke);
    useEffect(() => {
        chatbubble.configuration.stroke = strokeStyle;
        chatbubble.preview.clear();
        chatbubble.preview.drawBubble();
    }, [strokeStyle]);
    const [fillStyle, setFillStyle] = useState(chatbubble.configuration.fill);
    useEffect(() => {
        chatbubble.configuration.fill = fillStyle;
        chatbubble.preview.clear();
        chatbubble.preview.drawBubble();
    }, [fillStyle]);

    const shapes = chatbubble.configuration.shapes();
    return <>
        <Select
            options={[
                { value: ChatbubbleExportFormat.GIF, label: "GIF" },
                { value: ChatbubbleExportFormat.PNG, label: "PNG" },
                { value: ChatbubbleExportFormat.MP4, label: "MP4" },
                { value: ChatbubbleExportFormat.WEBM, label: "WEBM" },
            ]}
            placeholder={"Output Format"}
            maxVisibleItems={5}
            closeOnSelect={true}
            isSelected={v => v === format}
            serialize={v => String(v)}
            select={v => { setFormat(v); }}
        />
        <Button>
            {/* TODO: Find a way to import or imitate Discord's color picker. Or make my own, with alpha support. */}
            <input
                value={fillStyle.slice(0, "#".length + 6)}
                type="color"
                onChange={event => setFillStyle(event.target.value as Color.Hex)}
            />
            <span>Edit Fill Color</span>
        </Button>
        <Forms.FormSection>
            <Forms.FormTitle>Border</Forms.FormTitle>
            <CheckedTextInput
                type="number"
                value={String(strokeStyle.width)}
                validate={input => {
                    console.log(input);
                    return !Number.isNaN(+input) ? true : "Input must be a number!";
                }}
                onChange={value => setStrokeStyle({ ...strokeStyle, width: +value })}
                maxLength={3}
            />
            <Button>
                {/* TODO: Find a way to import or imitate Discord's color picker. Or make my own, with alpha support. */}
                <input
                    value={fillStyle.slice(0, "#".length + 6)}
                    type="color"
                    onChange={event => setStrokeStyle({ ...strokeStyle, color: event.target.value as Color.Hex })}
                />
                <span>Edit Stroke Color</span>
            </Button>
        </Forms.FormSection>
        <Button
            color={Button.Colors.GREEN}
            onClick={() => close(true)}
        >Save Changes</Button >
        <Button
            color={Button.Colors.YELLOW}
            onClick={() => {
                shapes.invert({ y: true });
                chatbubble.preview.clear();
                chatbubble.preview.drawBubble();
            }}
        >Flip Vertically</Button >
    </>;
}

interface CanvasRenderingEnvironment {
    canvas: Canvas,
    context: CanvasContext2D;
}

type Tuple<T, N extends number, A extends T[] = []> = number extends N ? T[] : A["length"] extends N ? A : Tuple<T, N, [...A, T]>;

type DrawOptions =
    | { fill: CanvasContext2D["fillStyle"] | true; stroke?: undefined, lineWidth?: number; winding?: CanvasFillRule; }
    | { fill?: never, stroke?: CanvasContext2D["strokeStyle"] | true, lineWidth?: number; winding?: never; };

interface ShapePointTestable {
    testPoint(context: CanvasContext2D, space: Rectangle, coordinates: CoordinateTuple, winding?: CanvasFillRule): boolean;
    testPointOnLine(context: CanvasContext2D, space: Rectangle, coordinates: CoordinateTuple): boolean;
}

abstract class AbstractDrawnShape implements ShapePointTestable {
    public abstract testPoint(context: CanvasContext2D, space: Rectangle, coordinates: CoordinateTuple, winding?: CanvasFillRule): boolean;
    public abstract testPointOnLine(context: CanvasContext2D, space: Rectangle, coordinates: CoordinateTuple): boolean;
    public abstract draw(context: CanvasContext2D, space: Rectangle, options: DrawOptions): void;
    public cloneShallow() {
        const copy = { ...this };
        Reflect.setPrototypeOf(copy, this.constructor.prototype);
        return copy;
    }
}

abstract class AbstractDrawnPathedShape<P extends NormalizedPointList = NormalizedPointList> extends AbstractDrawnShape {
    constructor() { super(); }

    public abstract getNormalizedPoints(): P;
    public getPoints(space: Rectangle) {
        return this.getNormalizedPoints().toSpace(space);
    }

    public testPoint(context: CanvasContext2D, space: Rectangle, coordinates: CoordinateTuple, winding?: CanvasFillRule): boolean {
        return context.isPointInPath(this.getPath(space), ...coordinates, winding);
    }

    public testPointOnLine(context: CanvasContext2D, space: Rectangle, coordinates: CoordinateTuple): boolean {
        return context.isPointInStroke(this.getPath(space), ...coordinates);
    }

    public abstract getPath(scale: Dimensions): Path2D;

    protected applyStyle(context: CanvasContext2D, { fill, stroke, lineWidth }: Exclude<DrawOptions, "winding">) {
        context.lineWidth = lineWidth ?? 1;
        if (fill !== undefined && fill !== true) {
            context.fillStyle = fill;
        } else if (stroke !== undefined && stroke !== true)
            context.strokeStyle = stroke;
    }

    protected drawPath(context: CanvasContext2D, path: Path2D, options: DrawOptions) {
        this.applyStyle(context, options);
        if (options.fill !== undefined) {
            context.fill(path, options.winding);
        } else if (options.stroke !== undefined) {
            context.stroke(path);
        }
    }

    public draw(context: CanvasContext2D, space: Rectangle, options: DrawOptions) {
        this.drawPath(context, this.getPath(space), options);
    }
}

type PolygonPoints<N extends number> = NormalizedPointList<Tuple<CoordinateTuple, N>>;
class DrawnPolygon<N extends number = number> extends AbstractDrawnPathedShape<PolygonPoints<N>> {
    constructor(public normalizedPoints: PolygonPoints<N>) { super(); }
    public getNormalizedPoints(): PolygonPoints<N> { return this.normalizedPoints; }
    public getPath(space: Rectangle) {
        const points = this.getPoints(space) as CoordinateTuple[];
        const path = new Path2D();
        path.moveTo(...points[0] as CoordinateTuple);
        for (const point of points.slice(1)) {
            path.lineTo(...point);
        }
        path.closePath();
        return path;
    }
}


class DrawnBezierCurve extends DrawnPolygon<4> {
    constructor(normalizedPoints: PolygonPoints<4>) { super(normalizedPoints); }

    public applyCurveUpon(path: Path2D, space: Rectangle,
        curve: Tuple<CoordinateTuple, 3> =
            this.getNormalizedPoints().toSpace(space).slice(1) as never
    ) {
        path.bezierCurveTo(...curve.flat() as Flatten<typeof curve>);
    }

    public drawControlLines(context: CanvasContext2D, space: Rectangle, options: Extract<DrawOptions, { fill?: undefined; }>, points = this.getPoints(space) as Tuple<CoordinateTuple, 4>) {
        this.applyStyle(context, options);

        context.beginPath();
        context.moveTo(...points[0]);
        context.lineTo(...points[1]);
        context.stroke();

        context.beginPath();
        context.moveTo(...points[3]);
        context.lineTo(...points[2]);
        context.stroke();
    }

    public getPath(space: Rectangle, points = this.getPoints(space) as Tuple<CoordinateTuple, 4>) {
        const path = new Path2D();
        const [start, ...curve] = points;
        path.moveTo(...start);
        this.applyCurveUpon(path, space, curve);
        path.closePath();
        return path;
    }
}

function ImageSizedContainer({ dimensions, classes = [], children }: { dimensions: Dimensions, classes?: string[], children: React.ReactNode; }) {
    return <div
        className={cl("contain-force", ...classes)}
        style={{ "aspectRatio": dimensions.width + "/" + dimensions.height }}
    >{children}</div>;
}


// class DrawnBezierSpline extends DrawnPath {
//     constructor(public readonly curves: DrawnBezierCurve[]) { super(); }
//     public getNormalizedPoints(): NormalizedPointList<ChatbubblePoints.CoordinateTuple[]> {
//         return new NormalizedPointList(this.curves.map(curve => curve.getNormalizedPoints().normalized).flat());
//     }

//     public getPath(space: Rectangle): Path2D {
//         const path = new Path2D();
//         const start = this.curves[0].getPoints(space) as Tuple<CoordinateTuple, 4>;
//         path.moveTo(...start[0]);
//         this.curves[0].applyCurve(path, space, start.slice(1) as Tuple<CoordinateTuple, 3>);
//         for (const curve of this.curves.slice(1)) {
//             curve.applyCurve(path, space);
//         }
//         path.closePath();
//         return path;
//     }
// }

function Points({ dimensions, points, color, onChange: notifyChange, clamp }: {
    dimensions: Dimensions;
    points: NormalizedPointList;
    onChange: () => void;
    color: string;
    clamp: boolean;
}) {
    return <ImageSizedContainer classes={["editor-points"]} dimensions={dimensions}>
        {points.normalized.map((position, index) =>
            <PointVisualization
                size={10}
                color={color}
                position={position}
                onMove={position => {
                    points.normalized[index] = position;
                    notifyChange();
                }}
                clamp={clamp}
            />
        )}
    </ImageSizedContainer>;
}

function clamp(value: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, value));
}

function useDraggability({ ref, normalize = true, clamp: range, progressiveAdjustment = [0, 0],
    position,
    offset,
    onPointerMove,
    onPointerDown,
    onPointerUp
}: {
    position?: CoordinateTuple,
    ref: React.MutableRefObject<HTMLElement | null>,
    normalize?: boolean,
    onPointerMove: (position: CoordinateTuple, delta: CoordinateTuple, event: MouseEvent) => void,
    onPointerDown?: (event: MouseEvent) => void;
    onPointerUp?: (event: MouseEvent) => void;
    clamp?: boolean | [x: CoordinateTuple, y: CoordinateTuple];
    offset?: CoordinateTuple;
    progressiveAdjustment?: [number, number];
}) {
    if (range === true) range = normalize ? [[0, 1], [0, 1]] : ref.current !== null ? [[0, ref.current.clientWidth], [0, ref.current.clientHeight]] : null!;

    let start: PointerEvent | null = null;
    let last: PointerEvent | null = null;

    function updateStyledPosition(position: CoordinateTuple) {
        if (!ref.current) return;
        const { style } = ref.current;
        // uhh progressive adjustment no worky on normalize fixme or just remove non-normalize
        style.left = `calc(${position[0] * (normalize ? 100 : 1)}% - ${position[0] * progressiveAdjustment[0]}px)`;
        style.top = `calc(${position[1] * (normalize ? 100 : 1)}% - ${position[1] * progressiveAdjustment[1]}px)`;
    }

    function updatePosition(event: PointerEvent) {
        if (!ref.current) return;
        const container = ref.current.parentElement!;
        const origin = container.getBoundingClientRect();
        let x: number = (event.pageX - origin.x - start!.offsetX);
        let y: number = (event.pageY - origin.y - start!.offsetY);
        if (offset) {
            x += offset[0];
            y += offset[1];
        }
        if (normalize) {
            x /= origin.width - progressiveAdjustment[0];
            y /= origin.height - progressiveAdjustment[1];
        }
        if (range) {
            x = clamp(x, ...range[0] as [number, number]);
            y = clamp(y, ...range[1] as [number, number]);
        }
        const position = [x, y] as const;
        let dx = event.clientX - last!.clientX;
        let dy = event.clientY - last!.clientY;
        if (normalize) {
            dx /= origin.width;
            dy /= origin.height;
        }
        updateStyledPosition(position);
        onPointerMove(position, [dx, dy], event);
        last = event;
    }

    if (position) useEffect(() => {
        updateStyledPosition(position);
    }, [position]);

    function onInteractStart(event: PointerEvent) {
        if (event.button !== 0) return;
        onPointerDown?.(event);
        document.addEventListener("pointerup", event => {
            onPointerUp?.(event);
            document.removeEventListener("pointermove", updatePosition);
        }, { once: true });
        document.addEventListener("pointermove", updatePosition);
        start = event;
        last = event;
    }

    useEffect(() => {
        ref.current?.addEventListener("pointerdown", onInteractStart);
        return () => {
            ref.current?.removeEventListener("pointerdown", onInteractStart);
        };
    });
}

function PointVisualization({
    position,
    color,
    onMove: escalatePositionInfo,
    clamp,
    size
}: {
    size: number,
    color: string;
    position: CoordinateTuple;
    onMove: (position: CoordinateTuple) => void;
    clamp?: boolean;
}) {
    const ref = useRef<HTMLDivElement | null>(null);

    useDraggability({
        ref, position, clamp,
        onPointerMove: escalatePositionInfo,
        progressiveAdjustment: [size, size]
    });

    return <div
        ref={ref}
        style={{
            width: size,
            height: size,
            background: color
        }}
        className={cl("editor-point")}
    />;
}


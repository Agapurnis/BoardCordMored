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
import ErrorBoundary from "@components/ErrorBoundary";
import { SpeechIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, openModal, openModalLazy } from "@utils/modal";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByCodeLazy } from "@webpack";
import { Alerts, Button, lodash, Menu, React, Select, Text, UploadManager, useEffect, useMemo, useRef, useState, zustandCreate } from "@webpack/common";
import { Channel, Message } from "discord-types/general";
import { applyPalette, Encoder, GIFEncoder, quantize } from "gifenc";
import { Flatten } from "ts-pattern/dist/types/helpers";

import { assertUnreachable, ChatbubbleCanvasExportFormat, ChatbubbleExportFormat, ChatbubblePoints, Dimensions, isChatbubbleExportFormatSupportedWithoutFFmpeg, Rectangle } from "./shared";
type CoordinateTuple = ChatbubblePoints.CoordinateTuple;
type NormalizedPointList<T extends CoordinateTuple[] = CoordinateTuple[]> = ChatbubblePoints.NormalizedPointList<T>;
const { NormalizedPointList } = ChatbubblePoints;

declare const BRAND: unique symbol;
type Branded<T> = { [BRAND]: T; };
type Brand<T, U> = T & Branded<U>;

namespace Color {
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
        media.src = url;
    });
}

function makeCanvas(dimensions: Dimensions, type: typeof OffscreenCanvas): { canvas: OffscreenCanvas, context: OffscreenCanvasRenderingContext2D; };
function makeCanvas(dimensions: Dimensions, type: typeof HTMLCanvasElement): { canvas: HTMLCanvasElement, context: CanvasRenderingContext2D; };
function makeCanvas({ width, height }: Dimensions, type: typeof OffscreenCanvas | typeof HTMLCanvasElement): { canvas: HTMLCanvasElement | OffscreenCanvas, context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D; } {
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (type === OffscreenCanvas) {
        canvas = new OffscreenCanvas(width, height);
    } else {
        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.classList.add(cl("contain"));
    }
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
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


interface ChatbubblePointStore extends ChatbubblePoints.List.Entries {
    invert(list: ChatbubblePoints.List.Identifier, ...details: Parameters<NormalizedPointList["inverted"]>): void;
}
function makePointStore(initial: ChatbubblePoints.List.Entries) {
    const use = zustandCreate<ChatbubblePointStore>(set => ({
        ...initial,
        invert: (list, ...details) => set(state => ({ [list]: state[list].inverted(...details) })),
    }));
    return use;
}


const TRANSPARENT_CHECKERBOARD_LIGHT = "#EDEDEDC8";
const TRANSPARENT_CHECKERBOARD_DARK = "#FFFFFFC8";
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

class ChatbubbleCanvasRenderer {
    protected drawOutline(points: ChatbubblePoints.List.Identifier, style: string) {
        const normalized = this.configuration.points.getState()[points];
        const scaled = normalized.mul(this.canvas);
        this.context.strokeStyle = style;
        this.context.beginPath();
        this.context.moveTo(...scaled[0]);
        for (const point of scaled.slice(1)) {
            this.context.lineTo(...point);
        }
        this.context.stroke();
    }

    protected drawBezier() {
        const normalized = this.configuration.points.getState()[ChatbubblePoints.List.Identifier.Bezier];
        const scaled = normalized.toSpace(this.getOffsetCanvasSpace());
        this.context.beginPath();
        const [start, ...curve] = scaled;
        this.context.moveTo(...start);
        this.context.bezierCurveTo(...curve.flat() as Flatten<typeof curve>);
        this.context.closePath();
        this.context.fill();
    }

    protected drawSpike() {
        const normalized = this.configuration.points.getState()[ChatbubblePoints.List.Identifier.Spike];
        const scaled = normalized.toSpace(this.getOffsetCanvasSpace());
        this.context.beginPath();
        this.context.moveTo(...scaled[0]);
        for (const point of scaled.slice(1)) {
            this.context.lineTo(...point);
        }
        this.context.fill();
    }

    protected drawBubbleLines() {
        for (const list of [
            ChatbubblePoints.List.Identifier.Spike,
            ChatbubblePoints.List.Identifier.Bezier,
        ]) this.drawOutline(list, ChatbubblePoints.List.VisualizationColors[list]);
    }

    public drawBubble() {
        this.drawSpike();
        this.drawBezier();
        if (this.mode === DrawingMode.Preview) {
            this.drawBubbleLines();
        }
    }

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
        this.updateDrawStyle();
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
        this.updateDrawStyle();
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

    public updateDrawStyle() {
        const transparent = this.configuration.fill.match(/^#......FF$/);
        if (this.mode === DrawingMode.Final && transparent) {
            this.context.globalCompositeOperation = "destination-out";
            this.context.fillStyle = "black";
        } else {
            this.context.globalCompositeOperation = "source-over";
            this.context.fillStyle = transparent ? this.transparencyPattern.get() : this.configuration.fill;
        }
    }

    constructor(
        public readonly configuration: ChatbubbleConfiguration,
        protected readonly mode: DrawingMode,
        public readonly canvas: HTMLCanvasElement | OffscreenCanvas,
        public readonly context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
    ) {
        this.updateDrawStyle();
    }
}

class ChatbubbleConfiguration {
    public static readonly TRANSPARENT = "#000000FF" as Color.Hex;
    public static async forFile(file: File) {
        type MediaConstructor = new () => ConstructorParameters<typeof ChatbubbleConfiguration>[1];
        const media = await load((file.type.startsWith("image")
            ? HTMLImageElement
            : HTMLVideoElement
        ) as MediaConstructor, file, { autoRevoke: false });
        media.classList.add(cl("contain"));
        return new ChatbubbleConfiguration(file, media);
    }

    public readonly uncroppedResolution: Readonly<Dimensions>;
    constructor(
        public readonly file: File,
        public readonly source: HTMLImageElement | HTMLVideoElement,
    ) {
        if (source instanceof HTMLImageElement) {
            this.uncroppedResolution = Object.seal({
                width: source.naturalWidth,
                height: source.naturalHeight
            });
        } else {
            // not really but uh
            this.uncroppedResolution = Object.seal({
                width: source.videoWidth,
                height: source.videoHeight
            });
        }
    }

    public removeCropClip() {
        this.source.style.clipPath = String();
    }

    public updateCropClip() {
        const { x, y, width, height } = this.getCroppedRectangle({ width: 1, height: 1 });
        this.source.style.clipPath = "xywh(" + [x, y, width, height].map(n => (n * 100) + "%").join(" ") + ")";
    }

    public getCroppedRectangle(scale: Dimensions) {
        const [a, b] = this.points.getState()[ChatbubblePoints.List.Identifier.Crop].mul(scale);
        const [xlo, xhi] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]]; const w = xhi - xlo;
        const [ylo, yhi] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]]; const h = yhi - ylo;
        return {
            x: xlo,
            y: ylo,
            width: w,
            height: h,
        };
    }

    public fill = ChatbubbleConfiguration.TRANSPARENT;
    public format = ChatbubbleExportFormat.GIF;
    public readonly points = makePointStore({
        [ChatbubblePoints.List.Identifier.Crop]: new NormalizedPointList([[0, 0], [1, 1]]),
        [ChatbubblePoints.List.Identifier.Bezier]: new NormalizedPointList([[0, 0], [.25, .4], [0.75, .4], [1, 0]]),
        [ChatbubblePoints.List.Identifier.Spike]: new NormalizedPointList([[.25, 0], [.5, .5], [.75, 0]])
    });
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
        const dimensions = configuration.source instanceof HTMLImageElement
            ? configuration.source
            : { width: 10, height: 10 }; // It'll figure itself out...
        const preview = makeCanvas(dimensions, HTMLCanvasElement);
        this.preview = new ChatbubbleCanvasRenderer(configuration, DrawingMode.Preview, preview.canvas, preview.context);
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
            const renderer = new ChatbubbleCanvasRenderer(this.configuration, DrawingMode.Final, offscreen.canvas, offscreen.context);
            renderer.drawImage();
            renderer.drawBubble();
            return renderer.export(filename, format, quality);
        }

        // TODO: the path thing doesnt work if i dont launch it from terminal
        if (!hasFFmpeg) {
            // TODO: UI for errors
            alert("ermmm,,,, ffmpeg pls");
            throw new Error("ff-mpreg!!!!");
        }


        const transparent = this.configuration.fill === ChatbubbleConfiguration.TRANSPARENT;
        const bubble = (() => {
            const bounds = roundSpacial(this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution), Math.trunc);
            const offscreen = makeCanvas(bounds, OffscreenCanvas);
            const renderer = new ChatbubbleCanvasRenderer(this.configuration, DrawingMode.Final, offscreen.canvas, offscreen.context);
            if (transparent && (format.toString().startsWith("video") || format === ChatbubbleExportFormat.GIF)) {
                renderer.context.globalCompositeOperation = "source-over";
                renderer.context.fillStyle = "black";
                renderer.context.fillRect(0, 0, renderer.canvas.width, renderer.canvas.height);
            }
            renderer.updateDrawStyle();
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

function useOnSizeChange(element: HTMLElement, callback: () => void) {
    const observer = new ResizeObserver(callback);
    observer.observe(element);
    useEffect(() => () => observer.disconnect());
}

function getContainFit(element: HTMLElement, resolution: Dimensions) {
    const canonical = resolution.width / resolution.height;
    const stretched = element.clientWidth / element.clientHeight;

    let width: number;
    let height: number;
    if (canonical > stretched) {
        width = element.clientWidth;
        height = element.clientWidth / canonical;
    } else {
        width = element.clientHeight * canonical;
        height = element.clientHeight;
    }

    return { width, height };
}


function ChatbubbleEditor({ chatbubble }: { chatbubble: Chatbubble; }) {
    const { configuration: { source, uncroppedResolution: resolution }, preview } = chatbubble;

    const dimmed = useMemo(() => {
        const dimmed = source.cloneNode() as HTMLImageElement;
        dimmed.classList.add(cl("crop-dimmed"));
        return dimmed;
    }, [source]);

    useOnSizeChange(source, () => {
        preview.resize(getContainFit(source, resolution));
        draw();
    });

    function draw() {
        preview.clear();
        preview.drawBubble();
    }

    draw();
    return <>
        {ReactWrapHTML("div", {}, [dimmed, source, preview.canvas as HTMLCanvasElement])}
        <Points chatbubble={chatbubble} onChange={() => chatbubble.updateCropClip()} dimensions={resolution} clamp={true} list={ChatbubblePoints.List.Identifier.Crop} />
        <Points chatbubble={chatbubble} onChange={draw} dimensions={resolution} clamp={false} list={ChatbubblePoints.List.Identifier.Bezier} />
        <Points chatbubble={chatbubble} onChange={draw} dimensions={resolution} clamp={false} list={ChatbubblePoints.List.Identifier.Spike} />
    </>;
}

function ChatbubbleEditorFooter({ close, chatbubble }: {
    close: (save: boolean) => void,
    chatbubble: Chatbubble;
}) {
    const [format, setFormat] = useState(chatbubble.configuration.format);
    useEffect(() => { chatbubble.configuration.format = format; }, [format]);
    const [fillStyle, setFillStyle] = useState(chatbubble.configuration.fill);
    useEffect(() => {
        chatbubble.configuration.fill = fillStyle;
        chatbubble.preview.updateDrawStyle();
        chatbubble.preview.clear();
        chatbubble.preview.drawBubble();
    }, [fillStyle]);

    const colorButtonInputRef = useRef<HTMLInputElement>(null);
    const points = chatbubble.configuration.points();
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
                ref={colorButtonInputRef}
                value={fillStyle.slice(0, "#".length + 6)}
                type="color"
                onChange={event => setFillStyle(event.target.value as Color.Hex)}
            />
            <span>Edit Color</span>
        </Button>
        <Button
            color={Button.Colors.GREEN}
            onClick={() => close(true)}
        >Save Changes</Button >
        <Button
            color={Button.Colors.YELLOW}
            onClick={() => {
                points.invert(ChatbubblePoints.List.Identifier.Bezier, { y: true });
                points.invert(ChatbubblePoints.List.Identifier.Spike, { y: true });
                chatbubble.preview.clear();
                chatbubble.preview.drawBubble();
            }}
        >Flip Vertically</Button >
    </>;
}


function Points({ chatbubble, dimensions, list, onChange: notifyChange, clamp }: {
    chatbubble: Chatbubble,
    dimensions: Dimensions;
    list: ChatbubblePoints.List.Identifier;
    onChange: () => void;
    clamp: boolean;
}) {
    const points = chatbubble.configuration.points(state => state[list]).normalized;
    const color = ChatbubblePoints.List.VisualizationColors[list];

    return <div
        data-list-type={list}
        className={cl("editor-points", "contain-like")}
        style={{
            ["--vc-cb-editor-point-size" as never]: "10px",
            ["--vc-cb-editor-point-color" as never]: color,
            "aspectRatio": dimensions.width + "/" + dimensions.height
        }}
    >
        {points.map((position, index) =>
            <DraggableNormalizedPointVisualization
                color={color}
                position={position}
                onMove={position => { points[index] = position; notifyChange(); }}
                clamp={clamp}
            />
        )}
    </div>;
}

function clamp(value: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, value));
}

function first<T>(v: T, ...args: unknown[]): T { return v; }

function DraggableNormalizedPointVisualization({
    position,
    onMove: escalatePositionInfo,
    clamp: doClamp,
}: {
    color: string;
    position: CoordinateTuple;
    onMove: (position: CoordinateTuple) => void;
    clamp: boolean;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    let click: MouseEvent | null = null;

    function updateStyledPosition(position: CoordinateTuple) {
        if (!ref.current) return;
        const { style } = ref.current;
        style.left = `calc(${position[0] * 100}% - calc(${position[0]} * var(--vc-cb-editor-point-size)))`;
        style.top = `calc(${position[1] * 100}% - calc(${position[1]} * var(--vc-cb-editor-point-size)))`;
    }

    function updatePosition(event: MouseEvent) {
        if (!ref.current) return;
        const container = ref.current.parentElement!;
        const origin = container.getBoundingClientRect();
        const size = Number(window.getComputedStyle(container).getPropertyValue("--vc-cb-editor-point-size").slice(0, -"px".length));
        const x = (doClamp ? clamp : first)((event.pageX - origin.x - click!.offsetX) / (origin.width - size), 0, 1) as number;
        const y = (doClamp ? clamp : first)((event.pageY - origin.y - click!.offsetY) / (origin.height - size), 0, 1) as number;
        const position = [x, y] as const;
        updateStyledPosition(position);
        escalatePositionInfo(position);
    }

    useEffect(() => {
        updateStyledPosition(position);
    }, [position]);

    return <div ref={ref} onMouseDown={event => {
        if (event.button !== 0) return; // TODO: mobile?
        document.addEventListener("mouseup", () => {
            document.removeEventListener("mousemove", updatePosition);
        }, { once: true });
        document.addEventListener("mousemove", updatePosition);
        click = event.nativeEvent;
    }} />;
}


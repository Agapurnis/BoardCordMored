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
import { Alerts, Button, Menu, React, Select, Text, UploadManager, useEffect, useMemo, useRef, useState, zustandCreate } from "@webpack/common";
import { Channel } from "discord-types/general";
import { applyPalette, Encoder, GIFEncoder, quantize } from "gifenc";
import { Flatten } from "ts-pattern/dist/types/helpers";

import { Dimensions } from "./shared";

type Tuple<T, N extends number, A extends T[] = []> = A["length"] extends N ? A : Tuple<T, N, [...A, T]>;
type CoordinateTuple = readonly [x: number, y: number];

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

function onMount(effect: () => void) { useEffect(effect); }
function onUnmounting(effect: () => void) { useEffect(() => effect()); }

const cl = classNameFactory("vc-cb-");

function ReactWrapHTML(type: string, props: Record<string, unknown>, children: HTMLElement[]) {
    return React.createElement(type, {
        ...props,
        ref: (element: HTMLElement) => {
            element?.append(...children);
        }
    });
}

function loadImage(from: Blob | MediaSource, { autoRevoke = true } = {}) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const url = URL.createObjectURL(from);
        const image = new Image();
        image.onerror = event => {
            URL.revokeObjectURL(url);
            reject(new Error("Could not load image", { cause: event }));
        };
        image.onload = () => {
            if (autoRevoke) URL.revokeObjectURL(url);
            resolve(image);
        };
        image.src = url;
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


function ChatBubbleContextMenuItem({ url, channel }: { url: string, channel: Channel; }) {
    return (
        <Menu.MenuItem
            icon={SpeechIcon}
            label="Chatbubble-ify"
            key="chatbubble-prompt"
            id="chatbubble-prompt"
            action={async () => {
                const contents = [await (await fetch(url)).blob()];
                const file = new File(contents, "bubble.gif", {
                    lastModified: Date.now(),
                    type: "image/gif",
                });
                const chatbubble = await Chatbubble.forFile(file);

                openModal(props => <EditorModal
                    modal={props}
                    chatbubble={chatbubble}
                    close={async save => {
                        props.onClose();
                        if (save) {
                            const file = await chatbubble.export("bubble");
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
                        }
                    }}
                />);
            }}
        />
    );
}

// yoinked from translate plugin
const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    console.log(children, props);
    if (props?.reverseImageSearchType !== "img") return; // im just gonna use this in lieu of my own thing for now FIXME
    const src = props.itemHref ?? props.itemSrc;
    const group = findGroupChildrenByChildId("copy-link", children);
    group?.push(ChatBubbleContextMenuItem({ url: src, channel: props.channel }));
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
            // TODO: Stole this from the anonymize image thing and it conflicts with that
            find: ".Messages.ATTACHMENT_UTILITIES_SPOILER",
            replacement: {
                match: /(?<=children:\[)(?=.{10,80}tooltip:.{0,100}\i\.\i\.Messages\.ATTACHMENT_UTILITIES_SPOILER)/,
                replace: "arguments[0].canEdit!==false?$self.renderIcon(arguments[0]):null,"
            },
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

    start() {
        window.nativeEval = Native.evaluate;
    },

    deregisterUpload(upload: Upload) {
        // TODO
        console.log(upload);
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
                                chatbubble.configuration.persistUnderAssociatedFile(file);
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
        "message": messageContextMenuPatch,
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


// for `object-fit: contain`
// function computeImageRenderedSize(image: HTMLImageElement) {
//     const a = image.naturalWidth / image.naturalHeight;
//     const b = image.width / image.height;
//     let width = 0;
//     let height = 0;

//     if (b < a) {
//         width = image.width;
//         height = image.width / a;
//     } else {
//         width = image.height * a;
//         height = image.height;
//     }

//     return { width, height };
// }



interface Rectangle extends Dimensions {
    x: number,
    y: number;
}

// import { StoreApi, UseBoundStore } from "zustand";
// type ExtractState<S> = S extends { getState: () => infer T; } ? T : never;
// type WithSelectors<S extends StoreApi<object>, P extends keyof ExtractState<S> = keyof ExtractState<S>> = S & { use: { [K in P]: () => ExtractState<S>[K] }; };
// // Modified version of <https://zustand.docs.pmnd.rs/guides/auto-generating-selectors#create-the-following-function:-createselectors>
// function createSelectors<S extends UseBoundStore<StoreApi<object>>, P extends keyof ExtractState<S> = keyof ExtractState<S>>(store: S, properties: P[]): WithSelectors<typeof store, P>;
// function createSelectors<S extends UseBoundStore<StoreApi<object>>>(store: S): WithSelectors<typeof store>;
// function createSelectors<S extends UseBoundStore<StoreApi<object>>, P extends keyof ExtractState<S> = keyof ExtractState<S>>(store: S, properties = Object.keys(store.getState()) as P[]): WithSelectors<typeof store, P> {
//     const modded = store as WithSelectors<typeof store, P>;
//     modded.use = {} as typeof modded["use"];
//     for (const k of properties) modded.use[k] = () => store(s => s[k as keyof typeof s]);
//     return modded;
// }


type CubicBezierPoints = Tuple<CoordinateTuple, 4>;
type CropPoints = Tuple<CoordinateTuple, 2>;
type SpikePoints = Tuple<CoordinateTuple, 3>;

class NormalizedPointList<T extends CoordinateTuple[] = CoordinateTuple[]> {
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

const enum PointListIdentifier {
    Bezier,
    Spike,
    Crop
}
function serializePointListIdentifier(identifier: PointListIdentifier) {
    return {
        [PointListIdentifier.Bezier]: "Bezier",
        [PointListIdentifier.Spike]: "Spike",
        [PointListIdentifier.Crop]: "Crop"
    }[identifier];
}
interface ChatbubblePointsEntries {
    [PointListIdentifier.Bezier]: NormalizedPointList<CubicBezierPoints>;
    [PointListIdentifier.Spike]: NormalizedPointList<SpikePoints>;
    [PointListIdentifier.Crop]: NormalizedPointList<CropPoints>;
}
interface ChatbubblePointStoreActions {
    invert(list: PointListIdentifier, ...details: Parameters<NormalizedPointList["inverted"]>): void;
    // invertAAA(): void;
}
interface ChatbubblePointStore extends ChatbubblePointsEntries, ChatbubblePointStoreActions { }
function makePointStore(initial: ChatbubblePointsEntries) {
    const use = zustandCreate<ChatbubblePointStore>(set => ({
        ...initial,
        invert: (list, ...details) => set(state => ({ [list]: state[list].inverted(...details) })),
        // invertAAA: () => {
        //     set(state => ({
        //         [PointListIdentifier.Bezier]: state[PointListIdentifier.Bezier].inverted({ y: true }),
        //         [PointListIdentifier.Spike]: state[PointListIdentifier.Spike].inverted({ y: true })
        //     }));
        // }
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

const enum ExportFormat {
    PNG = 1,
    GIF
}

class ChatbubbleRenderer {
    protected drawOutline(points: PointListIdentifier, style: string) {
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
        const scaled = this.configuration.points.getState()[PointListIdentifier.Bezier].toSpace(this.getOffsetCanvasSpace());
        this.context.beginPath();
        const [start, ...curve] = scaled;
        this.context.moveTo(...start);
        this.context.bezierCurveTo(...curve.flat() as Flatten<typeof curve>);
        this.context.closePath();
        this.context.fill();
    }

    protected drawSpike() {
        const scaled = this.configuration.points.getState()[PointListIdentifier.Spike].toSpace(this.getOffsetCanvasSpace());
        this.context.beginPath();
        this.context.moveTo(...scaled[0]);
        for (const point of scaled.slice(1)) {
            this.context.lineTo(...point);
        }
        this.context.fill();
    }

    protected drawBubbleLines() {
        this.drawOutline(PointListIdentifier.Spike, "red");
        this.drawOutline(PointListIdentifier.Bezier, "blue");
    }

    public draw() {
        this.drawSpike();
        this.drawBezier();
        if (this.mode === DrawingMode.Preview) {
            this.drawBubbleLines();
        }
    }

    public clear() {
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    protected drawOverlaid() {
        this.context.globalCompositeOperation = "source-over";
        const { x, y } = this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution);
        this.context.drawImage(this.configuration.image,
            x, y, this.canvas.width, this.canvas.height,
            0, 0, this.canvas.width, this.canvas.height
        );
        this.updateDrawStyle();
    }

    protected getOverlaidOnImage(clear: boolean): ImageData {
        this.configuration.removeCropClip();
        this.drawOverlaid();
        this.draw();
        const imageData = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
        if (clear) {
            this.clear();
            this.draw();
        }
        this.configuration.updateCropClip();
        return imageData;
    }

    protected exportGIF(): Encoder {
        const gif = GIFEncoder();
        const { data, width, height } = this.getOverlaidOnImage(true);
        const palette = quantize(data, 256, { format: "rgba4444", });
        const index = applyPalette(data, palette, "rgba4444");
        gif.writeFrame(index, width, height, { transparent: true, palette, });
        gif.finish();
        return gif;
    }

    protected async exportPNG(quality?: number): Promise<Blob> {
        this.drawOverlaid();
        this.draw();
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

    public async export(filename: string, format: ExportFormat = this.configuration.format): Promise<File> {
        let contents: BlobPart[] = [];
        let extension: string;
        let mime: string;
        switch (format) {
            case ExportFormat.GIF: {
                contents = [this.exportGIF().bytesView()];
                extension = "gif";
                mime = "image/gif";
                break;
            }
            case ExportFormat.PNG: {
                contents = [await this.exportPNG()];
                extension = "png";
                mime = "image/png";
                break;
            }
            default: {
                throw new Error("Unhandled format!");
            }
        }
        return new File(contents, filename + "." + extension, {
            lastModified: Date.now(),
            type: mime,
        });
    }

    public resize(dimensions: Dimensions) {
        this.canvas.width = dimensions.width;
        this.canvas.height = dimensions.height;
        this.updateDrawStyle();
    }

    public getOffsetCanvasSpace(): Rectangle {
        if (this.mode === DrawingMode.Preview) {
            const { width, height } = this.canvas;
            return { width, height, x: 0, y: 0 };
        }
        if (this.mode === DrawingMode.Final) {
            // const { width, height } = this.configuration.uncroppedResolution;
            const { width, height } = this.configuration.uncroppedResolution;
            const { x, y } = this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution);
            console.log({
                canvas: this.canvas,
                full: this.configuration.uncroppedResolution,
                cropped: this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution),
                metacrop: this.configuration.getCroppedRectangle(this.canvas)
            });
            return { width, height, x: -x, y: -y };
        }
        throw new Error("unhandled"); // FIXME use exhaustive
    }

    protected readonly transparencyPattern = new LazyDirtyable(() => {
        const checkboard = makeCheckerboardTransparencyPattern(20);
        return this.context.createPattern(checkboard, "repeat")!;
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
    private static readonly fileMapped = new Map<File, ChatbubbleConfiguration>();
    public static async forFile(file: File) {
        const existing = this.fileMapped.get(file);
        if (existing) return existing;
        const image = await loadImage(file, { autoRevoke: false });
        image.classList.add(cl("contain"));
        return new ChatbubbleConfiguration(image, true);
    }

    public readonly uncroppedResolution: Readonly<Dimensions>;
    constructor(
        public readonly image: HTMLImageElement,
        protected readonly doRevoke = false
    ) {
        this.uncroppedResolution = Object.seal({
            width: this.image.naturalWidth,
            height: this.image.naturalHeight
        });
    }

    public release() {
        if (this.doRevoke) URL.revokeObjectURL(this.image.src);
    }

    public removeCropClip() {
        this.image.style.clipPath = String();
    }

    public updateCropClip() {
        const { x, y, width, height } = this.getCroppedRectangle({ width: 1, height: 1 });
        this.image.style.clipPath = "xywh(" + [x, y, width, height].map(n => (n * 100) + "%").join(" ") + ")";
    }

    public getCroppedRectangle(scale: Dimensions) {
        const [a, b] = this.points.getState()[PointListIdentifier.Crop].mul(scale);
        const [xlo, xhi] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]]; const w = xhi - xlo;
        const [ylo, yhi] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]]; const h = yhi - ylo;
        return {
            x: xlo,
            y: ylo,
            width: w,
            height: h,
        };
    }

    private readonly associatedFile?: File;
    public persistUnderAssociatedFile(newAssociatedFile?: File) {
        if (newAssociatedFile) {
            ChatbubbleConfiguration.fileMapped.delete(this.associatedFile!);
            ChatbubbleConfiguration.fileMapped.set(newAssociatedFile, this);
        } else if (this.associatedFile) {
            ChatbubbleConfiguration.fileMapped.set(this.associatedFile, this);
        }
    }

    public fill = "#000000FF" as Color.Hex;
    public format = ExportFormat.GIF;
    public readonly points = makePointStore({
        [PointListIdentifier.Crop]: new NormalizedPointList([[0, 0], [1, 1]]),
        [PointListIdentifier.Bezier]: new NormalizedPointList([[0, 0], [.25, .4], [0.75, .4], [1, 0]]),
        [PointListIdentifier.Spike]: new NormalizedPointList([[.25, 0], [.5, .5], [.75, 0]])
    });
}

class Chatbubble {
    public static async forFile(file: File) {
        return new Chatbubble(await ChatbubbleConfiguration.forFile(file));
    }

    public readonly preview: ChatbubbleRenderer;

    constructor(
        public readonly configuration: ChatbubbleConfiguration
    ) {
        const preview = makeCanvas(configuration.image, HTMLCanvasElement);
        this.preview = new ChatbubbleRenderer(configuration, DrawingMode.Preview, preview.canvas, preview.context);
        this.updateCropClip();
    }

    public updateCropClip() {
        this.configuration.updateCropClip();
    }

    public readonly [Symbol.dispose] = this.release;
    public release() {
        this.configuration.release();
    }

    public async export(filename: string, format?: ExportFormat) {
        const offscreen = makeCanvas(this.configuration.getCroppedRectangle(this.configuration.uncroppedResolution), OffscreenCanvas);
        const renderer = new ChatbubbleRenderer(this.configuration, DrawingMode.Final, offscreen.canvas, offscreen.context);
        return renderer.export(filename, format);
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
                        body: "Exiting without saving will disgard all changes.",
                        onConfirm: () => close(false),
                        confirmText: "Confirm",
                        cancelText: "Nevermind"
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


function ChatbubbleEditor({ chatbubble }: { chatbubble: Chatbubble; }) {
    const { configuration: { image, uncroppedResolution: resolution }, preview } = chatbubble;
    const dimmed = useMemo(() => {
        const dimmed = image.cloneNode() as HTMLImageElement;
        dimmed.classList.add(cl("crop-dimmed"));
        return dimmed;
    }, [image]);

    useOnSizeChange(image, () => {
        preview.resize(image);
        draw();
    });

    function draw() {
        preview.clear();
        preview.draw();
    }

    draw();
    return <>
        {ReactWrapHTML("div", {}, [dimmed, image, preview.canvas as HTMLCanvasElement])}
        <Points chatbubble={chatbubble} onChange={() => chatbubble.updateCropClip()} dimensions={resolution} color="#00FF00" list={PointListIdentifier.Crop} />
        <Points chatbubble={chatbubble} onChange={draw} dimensions={resolution} color="#0000FF" list={PointListIdentifier.Bezier} />
        <Points chatbubble={chatbubble} onChange={draw} dimensions={resolution} color="#FF0000" list={PointListIdentifier.Spike} />
    </>;
}

function ChatbubbleEditorFooter({ close, chatbubble }: {
    close: (save: boolean) => void,
    chatbubble: Chatbubble;
}) {
    const [format, setFormat] = useState(chatbubble.configuration.format);
    useEffect(() => { format && (chatbubble.configuration.format = format); }, [format]);

    const colorButtonInputRef = useRef<HTMLInputElement>(null);
    const points = chatbubble.configuration.points();
    return <>
        <Select
            options={[
                { value: ExportFormat.GIF, label: "GIF" },
                { value: ExportFormat.PNG, label: "PNG" }
            ]}
            placeholder={"Output Format"}
            maxVisibleItems={5}
            closeOnSelect={true}
            isSelected={v => v === format}
            serialize={v => String(v)}
            select={v => { setFormat(v); }}
        />
        <Button>
            {/* TODO: Find a way to import or immitate Discord's color picker. Or make my own, with alpha support. */}
            <input
                ref={colorButtonInputRef}
                value={chatbubble.configuration.fill.slice(0, "#".length + 6)}
                type="color"
                onChange={e => {
                    // todo: change color on this with the ref except make the text have contrast background
                    chatbubble.configuration.fill = e.target.value as Color.Hex;
                    chatbubble.preview.updateDrawStyle();
                    chatbubble.preview.clear();
                    chatbubble.preview.draw();
                }}
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
                points.invert(PointListIdentifier.Bezier, { y: true });
                points.invert(PointListIdentifier.Spike, { y: true });
                chatbubble.preview.clear();
                chatbubble.preview.draw();
            }}
        >Flip Vertically</Button >
    </>;
}


function Points({ chatbubble, color, dimensions, list, onChange: notifyChange }: {
    chatbubble: Chatbubble,
    color: string;
    dimensions: Dimensions;
    list: PointListIdentifier;
    onChange: () => void;
}) {
    const points = chatbubble.configuration.points(state => state[list]).normalized;

    return <div
        data-listtype={serializePointListIdentifier(list)}
        className={cl("editor-points", "contain")}
        style={{
            ["--vc-cb-editor-point-size" as never]: "10px",
            ["--vc-cb-editor-point-color" as never]: color,
            "aspectRatio": dimensions.width + "/" + dimensions.height
        }}
    >
        {points.map((position, index) =>
            <DraggableNormalizedPointVisualization
                position={position}
                onMove={position => { points[index] = position; notifyChange(); }}
            />
        )}
    </div>;
}

function clamp(value: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, value));
}

function DraggableNormalizedPointVisualization({
    position,
    onMove: escalatePositionInfo,
}: {
    position: CoordinateTuple;
    onMove: (position: CoordinateTuple) => void;
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
        const x = clamp((event.pageX - origin.x - click!.offsetX) / (origin.width - size), 0, 1);
        const y = clamp((event.pageY - origin.y - click!.offsetY) / (origin.height - size), 0, 1);
        const position = [x, y] as const;
        updateStyledPosition(position);
        escalatePositionInfo(position);
    }

    useEffect(() => {
        updateStyledPosition(position);
    }, [position]);

    return <div
        ref={ref}
        onMouseDown={event => {
            if (event.button !== 0) return; // TODO: mobile?
            document.addEventListener("mouseup", () => {
                document.removeEventListener("mousemove", updatePosition);
            }, { once: true });
            document.addEventListener("mousemove", updatePosition);
            click = event.nativeEvent;
        }}
    />;
}


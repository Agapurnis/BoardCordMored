/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

type Nullish = null | undefined;

const enum PromiseState {
    Pending = "pending",
    Fulfilled = "fulfilled",
    Rejected = "rejected",
}

type TypedPromiseExecutor<T, E> = (
    resolve: (value: T) => void,
    reject: (error: E) => void
) => void;

type StatefulPromisePrimaryPrivateConstructorParameters<T, E> = Partial<[
    status: PromiseState,
    outcome: T | E | null
]>;

class StatefulPromise<T, E = any> implements Promise<T> {
    protected static createUnsafe<T, E = any>(first: TypedPromiseExecutor<T, E> | Promise<E>, ...args: StatefulPromisePrimaryPrivateConstructorParameters<T, E>) {
        // @ts-expect-error
        return new StatefulPromise(first, ...args);
    }

    public static wrap<T>(promise: Promise<T>) {
        return new StatefulPromise(promise);
    }
    public static resolved<T>(value: T) {
        return this.createUnsafe(Promise.resolve(value), PromiseState.Fulfilled, value);
    }

    public readonly [Symbol.toStringTag] = "StatefulPromise";
    public get status(): PromiseState { return this._status; }
    protected _status: PromiseState;
    protected _outcome: T | E | null;
    protected _promise: Promise<T>;
    protected _updater?: Promise<void>;

    constructor(executor: TypedPromiseExecutor<T, E>);
    constructor(promise: Promise<T>);
    constructor(first: TypedPromiseExecutor<T, E> | Promise<T>, ...[status, outcome]: StatefulPromisePrimaryPrivateConstructorParameters<T, E>) {
        if (first instanceof Promise) {
            this._promise = first;
            this._outcome = outcome ?? null;
            this._status = status ?? PromiseState.Pending;
        } else {
            this._promise = new Promise(first);
            this._outcome = null;
            this._status = PromiseState.Pending;
        }

        if (this._status === PromiseState.Pending) {
            this._updater = this._promise.then(
                value => {
                    this._status = PromiseState.Fulfilled;
                    this._outcome = value;
                },
                error => {
                    this._status = PromiseState.Rejected;
                    this._outcome = error!;
                }
            );
        }
    }

    public then<Then = T, Fallback = never>(
        onfulfilled?: ((value: T) => Then | PromiseLike<Then>) | Nullish,
        onrejected?: ((reason: E) => Fallback | PromiseLike<Fallback>) | Nullish,
    ): Promise<Then | Fallback> {
        return this._promise.then(onfulfilled, onrejected);
    }

    public catch<Fallback = never>(onrejected?: ((reason: E) => Fallback | PromiseLike<Fallback>) | Nullish): Promise<T | Fallback> {
        return this._promise.catch(onrejected);
    }

    public finally(onfinally?: (() => void) | Nullish): Promise<T> {
        return this._promise.finally(onfinally);
    }
}

class SuspensePromise<T, E = any> extends StatefulPromise<T, E> {
    /**
     * @throws the promise if it is still pending, or the error if the promise has rejected
     * @returns the result if the promise has been fulfilled
     */
    public read(): T {
        switch (this.status) {
            case PromiseState.Pending: throw this;
            case PromiseState.Rejected: throw this._outcome as E;
            case PromiseState.Fulfilled: return this._outcome as T;
        }
    }
}

export function usePromiseExecutor<T, E>(
    executor: TypedPromiseExecutor<T, E>,
    cleanup?: (promise: SuspensePromise<T>) => void
): T | null {
    const [promise, setPromise] = useState<SuspensePromise<T> | null>(null);

    useEffect(() => {
        const promise = new SuspensePromise(executor);
        setPromise(promise);
        return () => cleanup?.(promise);
    }, []);

    if (promise) return promise.read();

    return null;
}


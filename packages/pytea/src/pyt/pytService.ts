/*
 * pytService.ts
 * Copyright (c) Seoul National University
 * Licensed under the MIT license.
 * Author: Ho Young Jhoo
 *
 * Main class of PyTea analyzer.
 * Managing imported or will be imported scripts, parsed statements and lsp services.
 */
import * as chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

import { Program } from 'pyright-internal/analyzer/program';
import { AnalyzerService } from 'pyright-internal/analyzer/service';
import { ConfigOptions } from 'pyright-internal/common/configOptions';
import { ConsoleInterface, StandardConsole } from 'pyright-internal/common/console';
import { combinePaths } from 'pyright-internal/common/pathUtils';

import { fetchAddr } from '../backend/backUtils';
import { ContextSet } from '../backend/context';
import { ShHeap } from '../backend/sharpEnvironments';
import { ShContFlag, ShValue, SVSize, SVString, SVType } from '../backend/sharpValues';
import { SymExp } from '../backend/symExpressions';
import { TorchBackend } from '../backend/torchBackend';
import { ThStmt } from '../frontend/torchStatements';
import { PytOptions, PytOptionsPart } from './pytOptions';
import * as PytUtils from './pytUtils';

let _service: PytService | undefined;

export class PytService {
    private _options: PytOptions;
    private _config: ConfigOptions;

    private _service: AnalyzerService;
    private _console: ConsoleInterface;

    private _projectPath: string;
    private _entryPath: string;
    private _entryName: string;

    private _libStmt: Map<string, ThStmt>;
    private _projectStmt?: Map<string, ThStmt>;

    private _timeLog: [string, number][];
    private _currTime: number;

    constructor(
        service: AnalyzerService,
        pytOptions: PytOptionsPart,
        console?: ConsoleInterface,
        setDefault?: boolean
    ) {
        if (setDefault) _service = this;

        this._options = PytUtils.refineOptions(pytOptions);
        this._console = console || new StandardConsole();

        this._timeLog = [];
        this._currTime = performance.now();

        this._projectPath = '';
        this._entryPath = '';
        this._entryName = '';

        this._service = service;
        this._config = this._service.test_getConfigOptions(this._cmdOptions);

        this._libStmt = PytUtils.getTorchStmtsFromDir(service, this._options.pytLibPath!, this._config);
        if (this._options.entryPath) {
            this.setEntryPath(this._options.entryPath);
        }

        this._pushTimeLog('Parse Python scripts');
    }

    static getGlobalService(): PytService | undefined {
        return _service;
    }

    static setGlobalService(service: PytService): void {
        _service = service;
    }

    static shouldCheckImmediate(): boolean {
        return _service!._options.immediateConstraintCheck;
    }

    static log(...message: any[]): void {
        _service?._console.log(message.map((x) => `${x}`).join(' '));
    }

    static getOptions(): PytOptions {
        return _service!._options;
    }

    private _pushTimeLog(logName: string): void {
        const temp = this._currTime;
        this._currTime = performance.now();
        this._timeLog.push([logName, this._currTime - temp]);
    }

    getConfig(): ConfigOptions {
        return this._config;
    }

    // check library or entry file is fully loaded.
    validate(): boolean {
        let valid = true;

        if (!this._entryPath) {
            this._console.error('Python entry point is not set.');
            valid = false;
        }

        if (!this._projectStmt || this._projectStmt.size === 0) {
            this._console.error('Project directory is empty');
            valid = false;
        }

        if (!this._options.pytLibPath || this._libStmt.size === 0) {
            this._console.error('Invalid PyTea library path. Please check library path correctly.');
            valid = false;
        }

        return valid;
    }

    // return error message (string) or undefined
    setEntryPath(entryPath: string): string | undefined {
        if (!entryPath) {
            return 'path is blank';
        }

        const root = this._cmdOptions.executionRoot;
        const fullPath = combinePaths(root, entryPath);

        if (!fs.existsSync(fullPath)) {
            return `path ${fullPath} does not exists`;
        }

        if (path.extname(fullPath) !== '.py') {
            return `entry point ${fullPath} is not a python script`;
        }

        this._entryPath = fullPath;
        this._entryName = path.basename(fullPath, path.extname(fullPath));
        this._projectPath = path.join(fullPath, '..');
        this._projectStmt = PytUtils.getTorchStmtsFromDir(this._service, this._projectPath, this._config);

        return;
    }

    // if value is address, return fetchAddr(value, heap)
    // if that object has attr 'shape' and that is SVSize, return `Tensor ${value.size}`
    reducedToString(value: ShValue, heap: ShHeap): string {
        const obj = fetchAddr(value, heap);
        if (obj) {
            if (obj.type === SVType.Object) {
                const shape = obj.getAttr('shape');
                if (shape instanceof SVSize) {
                    return `Tensor ${SymExp.toString(shape.shape)}`;
                }
            }

            return obj.toString();
        } else {
            return value.toString();
        }
    }

    checkWithLog(): void {
        if (!this.validate()) {
            this._console.error('failed to validate PyTea service.');
            return;
        }

        const builtins = this._libStmt.get('builtins');
        if (!builtins) {
            this._console.error('cannot find PyTea implemenation of Python builtins.');
            return;
        }

        // TODO: consistent pytLibPath
        const builtinSet = TorchBackend.runBuiltin(builtins, 'builtins');
        const stmt = this._projectStmt?.get(this._entryName);
        if (!stmt) {
            this._console.error(`cannot parse entry file '${this._entryPath}'`);
            return;
        }

        this._pushTimeLog('Running builtin libraries');

        if (this._options.printIR)
            this._console.log(chalk.yellow(`PARSED STATEMENTS:`) + chalk.gray(`\n${ThStmt.toString(stmt)}\n`));

        const startSet = builtinSet.map((ctx) => {
            // set __name__ to '__main__'
            const [nameAddr, newHeap] = ctx.heap.allocNew(SVString.create('__main__'));
            return ctx.setRelPath(this._entryName).setEnv(ctx.env.setId('__name__', nameAddr)).setHeap(newHeap);
        });
        const result = TorchBackend.run(startSet, stmt);

        this._pushTimeLog('Running entry file');

        const logLevel = this._options.logLevel;
        switch (logLevel) {
            case 'none':
                this._noneLog(result);
                break;
            case 'result_only':
                this._resultOnlyLog(result);
                break;
            case 'reduced':
                this._reducedLog(result);
                break;

            case 'full':
                this._fullLog(stmt, result);
                break;
        }
    }

    checkUnittest(passOrFail: boolean): boolean {
        if (!this.validate()) {
            this._console.error('failed to validate PyTea service.');
            return false;
        }

        const builtins = this._libStmt.get('builtins');
        if (!builtins) {
            this._console.error('cannot find PyTea implemenation of Python builtins.');
            return false;
        }

        // TODO: consistent pytLibPath
        const builtinSet = TorchBackend.runBuiltin(builtins, 'builtins');
        const stmt = this._projectStmt?.get(this._entryName);
        if (!stmt) {
            this._console.error(`cannot parse entry file '${this._entryPath}'`);
            return false;
        }

        this._pushTimeLog('Running builtin libraries');

        // this._console.log(ThStmt.toString(stmt));

        const startSet = builtinSet.map((ctx) => {
            // set __name__ to '__main__'
            const [nameAddr, newHeap] = ctx.heap.allocNew(SVString.create('__main__'));
            return ctx.setRelPath(this._entryName).setEnv(ctx.env.setId('__name__', nameAddr)).setHeap(newHeap);
        });
        const result = TorchBackend.run(startSet, stmt);

        this._pushTimeLog('Running entry file');

        return this._unittestLog(passOrFail, result);
    }

    // Dynamic communications with Backend
    // import resolution order: (e.g. from A.B import C)
    //      1. project script   (A/B.py)
    //      2. __init__.py from project (A/B/__init__.py)
    //      3. library script (site-packages/A/B.py)
    //      4. __init__.py from project (site-packages/A/B/__init__.py)
    //
    // boolean value indicates imported from __init__
    getImportModuleStmt(qualPath: string): [ThStmt | undefined, boolean] {
        const initPath = qualPath + '.__init__';
        if (this._projectStmt?.has(qualPath)) {
            return [this._projectStmt.get(qualPath), false];
        } else if (this._projectStmt?.has(initPath)) {
            return [this._projectStmt.get(initPath), true];
        } else if (this._libStmt.has(qualPath)) {
            return [this._libStmt.get(qualPath), false];
        } else if (this._libStmt.has(initPath)) {
            return [this._libStmt.get(initPath), true];
        }

        return [undefined, false];
    }

    private _noneLog(result: ContextSet<ShValue | ShContFlag>): void {
        // do nothing.
    }

    private _resultOnlyLog(result: ContextSet<ShValue | ShContFlag>): void {
        const success = result.getList();
        const failed = result.getFailed();

        failed.forEach((ctx, i) => {
            const source = ctx.retVal.source;
            const toStr = PytUtils.nodePosToString;

            this._console.log(`failed path #${i + 1}: ${ctx.retVal.reason} / at ${ctx.relPath} ${toStr(source)}\n\n`);
        });

        this._pushTimeLog('printing results');

        this._console.log(
            chalk.green(`potential success path #: ${success.count()}\n`) +
                chalk.red(`immediate failed path #: ${failed.count()}\n\n`) +
                'RUNNING TIMES:\n' +
                this._timeLog.map(([name, interval]) => `  ${name}: ${(interval / 1000).toFixed(4)}s`).join('\n')
        );
    }

    private _reducedLog(result: ContextSet<ShValue | ShContFlag>): void {
        const success = result.getList();
        const failed = result.getFailed();

        const jsonList: string[] = [];

        success.forEach((ctx, i) => {
            jsonList.push(ctx.ctrSet.getConstraintJSON());

            let heapLog = '';
            // TODO: currently assume that address 1 is main module object
            //       do not hardcode.
            const module = ctx.heap.getVal(1);
            if (module?.type === SVType.Object) {
                heapLog =
                    `REDUCED HEAP: (size: ${ctx.heap.valMap.count()})\n` +
                    module.attrs
                        .map((v, k) => {
                            return `  ${k} => ${this.reducedToString(v, ctx.heap)}`;
                        })
                        .join('\n');
            }

            this._console.log(
                chalk.green(`success path #${i + 1}`) +
                    `\n\nLOGS:\n${ctx.logsToString()}\n\nCONSTRAINTS:\n${ctx.ctrSet.toString()}\n\n${heapLog}`
            );
        });

        failed.forEach((ctx, i) => {
            const source = ctx.retVal.source;
            const toStr = PytUtils.nodePosToString;

            const heapLog = ctx.env.addrMap
                .filter((v) => v.addr >= 0)
                .map((addr, key) => {
                    return `  ${key} => ${this.reducedToString(addr, ctx.heap)}`;
                })
                .join('\n');

            this._console.log(
                chalk.red(`failed path #${i + 1}`) +
                    `: ${ctx.retVal.reason} / at ${ctx.relPath} ${toStr(source)}\n\n` +
                    `LOGS:\n${ctx.logsToString()}\n\n` +
                    'CONSTRAINTS:\n' +
                    ctx.ctrSet.toString() +
                    '\n\nCALL STACK:\n' +
                    ctx.callStackToString() +
                    `\n\nREDUCED HEAP (${ctx.heap.valMap.count()}):\n${heapLog}`
            );
        });

        if (jsonList.length > 0) {
            const jsonPath = path.join(this._projectPath, `${this._entryName}_z3.json`);
            fs.writeFileSync(jsonPath, '[\n' + jsonList.join(',\n') + '\n]');
            this._console.log(`write path constraints to ${jsonPath}`);
        }

        this._pushTimeLog('printing results');

        this._console.log(
            chalk.green(`potential success path #: ${success.count()}\n`) +
                chalk.red(`immediate failed path #: ${failed.count()}\n\n`) +
                'RUNNING TIMES:\n' +
                this._timeLog.map(([name, interval]) => `  ${name}: ${(interval / 1000).toFixed(4)}s`).join('\n')
        );
    }

    private _fullLog(stmt: ThStmt, result: ContextSet<ShValue | ShContFlag>): void {
        const success = result.getList();
        const failed = result.getFailed();

        const jsonList: string[] = [];

        success.forEach((ctx, i) => {
            jsonList.push(ctx.ctrSet.getConstraintJSON());

            this._console.log(
                chalk.green(`success path #${i + 1}`) +
                    `\nLOGS:\n${ctx.logsToString()}\n` +
                    `CONSTRAINTS:\n${ctx.ctrSet.toString()}\n` +
                    `ENV:\n${ctx.env.toString()}\n` +
                    `HEAP (size: ${ctx.heap.valMap.count()}):\n${ctx.heap.filter((_, key) => key >= 0).toString()}\n`
            );
        });

        failed.forEach((ctx, i) => {
            const source = ctx.retVal.source;
            const toStr = PytUtils.nodePosToString;

            this._console.log(
                chalk.red(`failed path #${i + 1}`) +
                    `: ${ctx.retVal.reason} / at ${ctx.relPath} ${toStr(source)}\n` +
                    `LOGS:\n${ctx.logsToString()}\n` +
                    'CONSTRAINTS:\n' +
                    ctx.ctrSet.toString() +
                    '\n\nCALL STACK:\n' +
                    ctx.callStackToString() +
                    `\nENV:\n${ctx.env.toString()}\n` +
                    `\nHEAP (${ctx.heap.valMap.count()}):\n${ctx.heap.filter((_, key) => key >= 0).toString()}`
            );
        });

        if (jsonList.length > 0) {
            const jsonPath = path.join(this._projectPath, `${this._entryName}_z3.json`);
            fs.writeFileSync(jsonPath, '[\n' + jsonList.join(',\n') + '\n]');
            this._console.log(`write path constraints to ${jsonPath}`);
        }

        this._pushTimeLog('printing results');

        this._console.log(
            chalk.green(`potential success path #: ${success.count()}\n`) +
                chalk.red(`immediate failed path #: ${failed.count()}\n\n`) +
                'RUNNING TIMES:\n' +
                this._timeLog.map(([name, interval]) => `  ${name}: ${(interval / 1000).toFixed(4)}s`).join('\n')
        );
    }

    private _unittestLog(passOrFail: boolean, result: ContextSet<ShValue | ShContFlag>): boolean {
        const success = result.getList();
        const failed = result.getFailed();

        const jsonList: string[] = [];

        let hasSVError = false;

        success.forEach((ctx, i) => {
            jsonList.push(ctx.ctrSet.getConstraintJSON());

            let heapLog = '';
            // TODO: currently assume that address 1 is main module object
            //       do not hardcode.
            const module = ctx.heap.getVal(1);
            if (module?.type === SVType.Object) {
                heapLog =
                    `REDUCED HEAP: (size: ${ctx.heap.valMap.count()})\n` +
                    module.attrs
                        .map((v, k) => {
                            return `  ${k} => ${this.reducedToString(v, ctx.heap)}`;
                        })
                        .join('\n');
            }

            ctx.logs.forEach((value, i) => {
                if (value.type === SVType.Error) {
                    this._console.log(
                        `success path #${
                            i + 1
                        }\n\nLOGS:${ctx.logsToString()}\n\nCONSTRAINTS:\n${ctx.ctrSet.toString()}\n\n${heapLog}`
                    );
                    hasSVError = true;
                }
            });
        });

        if (passOrFail) {
            return failed.count() === 0 && !hasSVError;
        } else {
            return success.count() === 0 && !hasSVError;
        }
    }
}

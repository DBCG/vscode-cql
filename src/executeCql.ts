import { ExtensionContext, window, workspace, commands, Uri, ProgressLocation, ViewColumn, EventEmitter, extensions, Location, languages, CodeActionKind, TextEditor, TextDocument, Position, InputBoxOptions } from "vscode";
import { Commands } from "./commands";
import { prepareExecutable, awaitServerConnection } from "./languageServerStarter";
import { LanguageClientOptions, Position as LSPosition, Location as LSLocation, MessageType, TextDocumentPositionParams, ConfigurationRequest, ConfigurationParams, CancellationToken, ExecuteCommandRequest, ExecuteCommandParams } from "vscode-languageclient";

import * as cp from "child_process";
import * as fse from "fs-extra";
import * as _ from "lodash";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// NOTE: This is not the intended future state of executing CQL.
// There's a CQL debug server under development that will replace this.
export async function executeCQLFile(uri: Uri): Promise<void> {
	const libraryPath: string = uri.fsPath;
	if (!fs.existsSync(libraryPath)) {
		window.showInformationMessage("No library content found. Please save before executing.");
		return;
	}

	let periodStartInputOptions: InputBoxOptions = {
		title: "Reporting Period Start",
		placeHolder: "YYYY-MM-DDTHH:MM:SS-08:00"
	};
	let periodEndInputOptions: InputBoxOptions = {
		title: "Reporting Period End",
		placeHolder: "YYYY-MM-DDTHH:MM:SS-08:00"
	};
	const dateTimeRegex = /([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?/gm;
	const periodStart = await window.showInputBox(periodStartInputOptions);
	const periodEnd = await window.showInputBox(periodEndInputOptions);

	const periodStartTest = new RegExp(dateTimeRegex).exec(periodStart);
	const periodEndTest = new RegExp(dateTimeRegex).exec(periodEnd);

	const libraryPathName = path.basename(libraryPath, '.cql');

	// todo: replace with library-uri when it's ready
	const libraryDirectory = path.dirname(libraryPath);
	const libraryName = libraryPathName.split('-')[0];

	const projectPath = workspace.getWorkspaceFolder(uri).uri.fsPath;

	// todo: make this a setting
	const terminologyPath = path.join(projectPath, 'input', 'vocabulary', 'valueset');

	// todo: get this working (currently errors with: Index 0 out of bounds for length 0)
	// const measurementPeriod = 'Interval[@2019-01-01T00:00:00.0, @2020-01-01T00:00:00.0]';
	const modelType = "FHIR";
	const contextType = 'Patient';
	let fhirVersion = "R4";
	const optionsPath = path.join(libraryDirectory, 'cql-options.json');
	const measurementPeriod = periodStartTest && periodEndTest ? `Interval[@${periodStart}, @${periodEnd}]` : '';
	const testPath = path.join(projectPath, 'input', 'tests');
	const resultPath = path.join(testPath, 'results');

	const fhirVersionRegex = /using (FHIR|"FHIR") version '(\d(.|\d)*)'/;
	const matches = window.activeTextEditor.document.getText().match(fhirVersionRegex);
	if (matches && matches.length > 2) {
		const version = matches[2];
		if (version.startsWith("2")) {
			fhirVersion = "DSTU2";
		}
		else if (version.startsWith("3")) {
			fhirVersion = "DSTU3";
		}
		else if (version.startsWith("4")) {
			fhirVersion = "R4";
		}
		else if (version.startsWith("5")) {
			fhirVersion = "R5";
		}
	}
	else {
		fhirVersion = "R4";
		window.showInformationMessage("Unable to determine version of FHIR used. Defaulting to R4.");
	}

	// Recursively creates directory
	// mkDirByPathSync(resultPath);

	const modelRootPath = getModelRootPath(testPath, libraryPathName);

	const outputPath = path.join(resultPath, libraryPathName + '.txt');

	fse.ensureFileSync(outputPath);

	const textDocument = await workspace.openTextDocument(outputPath);
	const textEditor = await window.showTextDocument(textDocument);

	let terminologyPathActual = terminologyPath;
	if (!terminologyPath || terminologyPath === '' || !fs.existsSync(terminologyPath)) {
		terminologyPathActual = '';
	}

	const modelMessage = (modelRootPath && modelRootPath !== '') ? `Data path: ${modelRootPath}` : `No tests found at ${testPath}. Evaluation may fail if data is required.`;
	const terminologyMessage = (terminologyPathActual && terminologyPathActual !== '') ? `Terminology path: ${terminologyPathActual}` : `No terminology found at ${terminologyPath}. Evaluation may fail if terminology is required.`;

	await insertTextAtEnd(textEditor, 'Running tests.\r\n');
	await insertTextAtEnd(textEditor, `${modelMessage}\r\n`);
	await insertTextAtEnd(textEditor, `${terminologyMessage}\r\n`);

	let operationArgs = getCqlCommandArgs(fhirVersion, optionsPath);

	if (modelRootPath && modelRootPath !== '' && fs.existsSync(modelRootPath)) {
		const dirs = fs.readdirSync(modelRootPath)
			.filter(dirent => fs.statSync(path.join(modelRootPath, dirent)).isDirectory());

		if (dirs && dirs.length > 0) {
			dirs.forEach((dirent) => {
				const context = dirent;
				const modelPath = path.join(modelRootPath, dirent);
				operationArgs = getExecArgs(operationArgs, libraryDirectory, libraryName, modelType, modelPath, terminologyPathActual, context, measurementPeriod);
			});
		}
		else {
			operationArgs = getExecArgs(operationArgs, libraryDirectory, libraryName, modelType, null, terminologyPathActual, null, measurementPeriod);
		}
	}
	else {
		operationArgs = getExecArgs(operationArgs, libraryDirectory, libraryName, modelType, null, terminologyPathActual, null, measurementPeriod);
	}

	await executeCQL(textEditor, operationArgs);
}

function getModelRootPath(parentPath: string, libraryPathName: string): string {
	let modelRootPath = '';
	if (fs.existsSync(parentPath)) {
		const files = fs.readdirSync(parentPath);
		const dirs = files.filter(dirent => fs.statSync(path.join(parentPath, dirent)).isDirectory());
		dirs.forEach(dirent => {
			if (modelRootPath === '') {
				if (dirent === libraryPathName) {
					modelRootPath = path.join(parentPath, dirent);
				} else {
					modelRootPath = getModelRootPath(path.join(parentPath, dirent), libraryPathName);
				}
			}
		});
	}
	return modelRootPath;
}

async function insertTextAtEnd(textEditor: TextEditor, text: string) {
	const document = textEditor.document;
	await textEditor.edit(editBuilder => {
		editBuilder.insert(new Position(textEditor.document.lineCount, 0), text);
	});
}

async function executeCQL(textEditor: TextEditor, operationArgs: string[]) {
	const startExecution = new Date();
	const result: string = await commands.executeCommand(Commands.EXECUTE_WORKSPACE_COMMAND, Commands.EXECUTE_CQL, ...operationArgs);
	const endExecution = new Date();

	await insertTextAtEnd(textEditor, result);
	await insertTextAtEnd(textEditor, `elapsed: ${((endExecution.getMilliseconds() - startExecution.getMilliseconds()) / 1000).toString()} seconds\r\n\r\n`);
}

function getCqlCommandArgs(fhirVersion: string, optionsPath: string): string[] {
	const args = ["cql"];

	if (fhirVersion && fhirVersion !== '') {
		args.push(`-fv=${fhirVersion}`);
	}
	else {
		args.push(`-fv=R4`);
	}

	if (optionsPath && fs.existsSync(optionsPath)) {
		args.push(`-op=${optionsPath}`);
	}

return args;
}

function getExecArgs(args, libraryDirectory, libraryName, modelType, modelPath, terminologyPath, contextValue, measurementPeriod): string[] {
	args.push(`-ln=${libraryName}`);
	args.push(`-lu=${Uri.file(libraryDirectory)}`);

	if (modelType && modelType !== '' && modelPath && modelPath !== null) {
		args.push('-m=FHIR');
		args.push(`-mu=${Uri.file(modelPath)}`);
	}

	if (terminologyPath && terminologyPath !== '') {
		args.push(`-t=${Uri.file(terminologyPath)}`);
	}

	if (contextValue && contextValue !== '') {
		args.push(`-c=Patient`);
		args.push(`-cv=${contextValue}`);
	}

	if (measurementPeriod && measurementPeriod !== '') {
		args.push(`-p=${libraryName}."Measurement Period"`);
		args.push(`-pv=${measurementPeriod}`);
	}

	return args;
}

/**
 * This is a stub description for now.
 */
import expandTilde from 'expand-tilde';
import * as fse from 'fs-extra';
import * as path from 'path';
import { ExtensionContext, Uri, env } from 'vscode';
import { Commands } from './commands';
import { JavaRuntime, findJavaHomes, getJavaVersion } from './findJavaRuntimes';
import { getServicePath, installJavaDependencies } from './javaServiceInstaller';

const isWindows = process.platform.indexOf('win') === 0;
const JAVAC_FILENAME = 'javac' + (isWindows ? '.exe' : '');
const JAVA_FILENAME = 'java' + (isWindows ? '.exe' : '');
const REQUIRED_JDK_VERSION = 11;
const JDK_URL = 'https://adoptium.net/temurin/releases/';
export interface RequirementsData {
  java_requirements: JavaRequirements;
  cql_ls_info: CqlLsInfo;
}

export interface JavaRequirements {
  java_home: string;
  java_version: number;
}

export interface CqlLsInfo {
  cql_ls_jar: string;
}

/**
 * Resolves the requirements needed to run the extension.
 * Returns a promise that will resolve to a RequirementsData if
 * all requirements are resolved, it will reject with ErrorData if
 * if any of the requirements fails to resolve.
 *
 */
export async function resolveJavaRequirements(
  _context: ExtensionContext,
): Promise<JavaRequirements> {
  return new Promise(async (resolve, reject) => {
    let source: string;
    let javaVersion: number | undefined;

    let javaHome: string | undefined;
    // java.home not specified, search valid JDKs from env.JAVA_HOME, env.PATH, Registry(Window), Common directories
    const javaRuntimes = await findJavaHomes();
    const validJdks = javaRuntimes.filter(r => r.version >= REQUIRED_JDK_VERSION);
    if (validJdks.length > 0) {
      sortJdksBySource(validJdks);
      javaHome = validJdks[0].home;
      javaVersion = validJdks[0].version;
    }
    if (javaHome) {
      // java.home explicitly specified
      source = `java.home variable defined in ${env.appName} settings`;
      javaHome = expandTilde(javaHome);
      if (!(await fse.pathExists(javaHome!))) {
        rejectWithMessage(
          reject,
          `The ${source} points to a missing or inaccessible folder (${javaHome})`,
        );
      } else if (!(await fse.pathExists(path.resolve(javaHome!, 'bin', JAVAC_FILENAME)))) {
        let msg: string;
        if (await fse.pathExists(path.resolve(javaHome!, JAVAC_FILENAME))) {
          msg = `'bin' should be removed from the ${source} (${javaHome})`;
        } else {
          msg = `The ${source} (${javaHome}) does not point to a JDK.`;
        }
        rejectWithMessage(reject, msg);
      }
      javaVersion = await getJavaVersion(javaHome!);
    }

    if (javaVersion! < REQUIRED_JDK_VERSION) {
      openJDKDownload(
        reject,
        `Java ${REQUIRED_JDK_VERSION} or more recent is required to run the Java extension. Please download and install a recent JDK.`,
      );
    }

    resolve({ java_home: javaHome!, java_version: javaVersion! });
  });
}

export async function resolveJavaDependencies(context: ExtensionContext): Promise<CqlLsInfo> {
  return new Promise(async (resolve, reject) => {
    await installJavaDependencies(context);
    const cqlLsJar = getServicePath(context, 'cql-language-server');
    resolve({ cql_ls_jar: cqlLsJar });
  });
}

export async function resolveRequirements(context: ExtensionContext): Promise<RequirementsData> {
  const javaRequirements = await resolveJavaRequirements(context);
  const cqlRequirements = await resolveJavaDependencies(context);

  return {
    java_requirements: javaRequirements,
    cql_ls_info: cqlRequirements,
  };
}

function sortJdksBySource(jdks: JavaRuntime[]) {
  const rankedJdks = jdks as Array<JavaRuntime & { rank: number }>;
  const sources = ['env.JDK_HOME', 'env.JAVA_HOME', 'env.PATH'];
  for (const [index, source] of sources.entries()) {
    for (const jdk of rankedJdks) {
      if (jdk.rank === undefined && jdk.sources.includes(source)) {
        jdk.rank = index;
      }
    }
  }
  rankedJdks.filter(jdk => jdk.rank === undefined).forEach(jdk => (jdk.rank = sources.length));
  rankedJdks.sort((a, b) => a.rank - b.rank);
}

function openJDKDownload(
  reject: {
    (reason?: any): void;
    (arg0: { message: any; label: string; command: string; commandParam: Uri }): void;
  },
  cause: string,
) {
  reject({
    message: cause,
    label: 'Get the Java Development Kit',
    command: Commands.OPEN_BROWSER,
    commandParam: Uri.parse(JDK_URL),
  });
}

function rejectWithMessage(
  reject: {
    (reason?: any): void;
    (reason?: any): void;
    (arg0: { message: string }): void;
  },
  cause: string,
) {
  reject({
    message: cause,
  });
}

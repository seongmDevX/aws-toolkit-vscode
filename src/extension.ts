/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'

import { resumeCreateNewSamApp } from './lambda/commands/createNewSamApp'
import { SamParameterCompletionItemProvider } from './lambda/config/samParameterCompletionItemProvider'
import { RegionNode } from './lambda/explorer/regionNode'
import { LambdaTreeDataProvider } from './lambda/lambdaTreeDataProvider'
import { DefaultAWSClientBuilder } from './shared/awsClientBuilder'
import { AwsContextTreeCollection } from './shared/awsContextTreeCollection'
import { DefaultToolkitClientBuilder } from './shared/clients/defaultToolkitClientBuilder'
import { CodeLensProviderParams } from './shared/codelens/codeLensUtils'
import * as csLensProvider from './shared/codelens/csharpCodeLensProvider'
import * as pyLensProvider from './shared/codelens/pythonCodeLensProvider'
import * as tsLensProvider from './shared/codelens/typescriptCodeLensProvider'
import { documentationUrl, extensionSettingsPrefix, githubUrl, reportIssueUrl } from './shared/constants'
import { DefaultCredentialsFileReaderWriter } from './shared/credentials/defaultCredentialsFileReaderWriter'
import { UserCredentialsUtils } from './shared/credentials/userCredentialsUtils'
import { DefaultAwsContext } from './shared/defaultAwsContext'
import { DefaultAWSContextCommands } from './shared/defaultAwsContextCommands'
import { DefaultResourceFetcher } from './shared/defaultResourceFetcher'
import { DefaultAWSStatusBar } from './shared/defaultStatusBar'
import { EnvironmentVariables } from './shared/environmentVariables'
import { ext } from './shared/extensionGlobals'
import {
    safeGet,
    showQuickStartWebview,
    toastNewUser
} from './shared/extensionUtilities'
import * as logFactory from './shared/logger'
import { DefaultRegionProvider } from './shared/regions/defaultRegionProvider'
import * as SamCliContext from './shared/sam/cli/samCliContext'
import * as SamCliDetection from './shared/sam/cli/samCliDetection'
import { DefaultSettingsConfiguration, SettingsConfiguration } from './shared/settingsConfiguration'
import { AwsTelemetryOptOut } from './shared/telemetry/awsTelemetryOptOut'
import { DefaultTelemetryService } from './shared/telemetry/defaultTelemetryService'
import { TelemetryService } from './shared/telemetry/telemetryService'
import { TelemetryNamespace } from './shared/telemetry/telemetryTypes'
import { registerCommand } from './shared/telemetry/telemetryUtils'
import { ExtensionDisposableFiles } from './shared/utilities/disposableFiles'
import { PromiseSharer } from './shared/utilities/promiseUtilities'
import { getChannelLogger } from './shared/utilities/vsCodeUtils'

export async function activate(context: vscode.ExtensionContext) {

    const env = process.env as EnvironmentVariables
    if (!!env.VSCODE_NLS_CONFIG) {
        nls.config(JSON.parse(env.VSCODE_NLS_CONFIG) as nls.Options)()
    } else {
        nls.config()()
    }

    const localize = nls.loadMessageBundle()

    ext.context = context
    await logFactory.initialize()
    const toolkitOutputChannel = vscode.window.createOutputChannel(
        localize('AWS.channel.aws.toolkit', 'AWS Toolkit')
    )

    try {
        await new DefaultCredentialsFileReaderWriter().setCanUseConfigFileIfExists()

        const awsContext = new DefaultAwsContext(new DefaultSettingsConfiguration(extensionSettingsPrefix), context)
        const awsContextTrees = new AwsContextTreeCollection()
        const resourceFetcher = new DefaultResourceFetcher()
        const regionProvider = new DefaultRegionProvider(context, resourceFetcher)

        ext.awsContextCommands = new DefaultAWSContextCommands(awsContext, awsContextTrees, regionProvider)
        ext.sdkClientBuilder = new DefaultAWSClientBuilder(awsContext)
        ext.toolkitClientBuilder = new DefaultToolkitClientBuilder()

        // check to see if current user is valid
        const currentProfile = awsContext.getCredentialProfileName()
        if (currentProfile) {
            const successfulLogin = await UserCredentialsUtils.addUserDataToContext(currentProfile, awsContext)
            if (!successfulLogin) {
                await UserCredentialsUtils.removeUserDataFromContext(awsContext)
                // tslint:disable-next-line: no-floating-promises
                UserCredentialsUtils.notifyUserCredentialsAreBad(currentProfile)
            }
        }

        ext.statusBar = new DefaultAWSStatusBar(awsContext, context)
        ext.telemetry = new DefaultTelemetryService(context, awsContext)
        new AwsTelemetryOptOut(ext.telemetry, new DefaultSettingsConfiguration(extensionSettingsPrefix))
            .ensureUserNotified()
            .catch((err) => {
                console.warn(`Exception while displaying opt-out message: ${err}`)
            })
        await ext.telemetry.start()

        context.subscriptions.push(
            ...await activateCodeLensProviders(
                awsContext.settingsConfiguration,
                toolkitOutputChannel,
                ext.telemetry)
        )

        registerCommand({
            command: 'aws.login',
            callback: async () => await ext.awsContextCommands.onCommandLogin(),
            telemetryName: {
                namespace: TelemetryNamespace.Aws,
                name: 'credentialslogin'
            }
        })

        registerCommand({
            command: 'aws.credential.profile.create',
            callback: async () => await ext.awsContextCommands.onCommandCreateCredentialsProfile(),
            telemetryName: {
                namespace: TelemetryNamespace.Aws,
                name: 'credentialscreate'
            }
        })

        registerCommand({
            command: 'aws.logout',
            callback: async () => await ext.awsContextCommands.onCommandLogout(),
            telemetryName: {
                namespace: TelemetryNamespace.Aws,
                name: 'credentialslogout'
            }
        })

        registerCommand({
            command: 'aws.showRegion',
            callback: async () => await ext.awsContextCommands.onCommandShowRegion()
        })

        registerCommand({
            command: 'aws.hideRegion',
            callback: async (node?: RegionNode) => {
                await ext.awsContextCommands.onCommandHideRegion(safeGet(node, x => x.regionCode))
            }
        })

        // register URLs in extension menu
        registerCommand({
            command: 'aws.help',
            callback: async () => { vscode.env.openExternal(vscode.Uri.parse(documentationUrl)) }
        })
        registerCommand({
            command: 'aws.github',
            callback: async () => { vscode.env.openExternal(vscode.Uri.parse(githubUrl)) }
        })
        registerCommand({
            command: 'aws.reportIssue',
            callback: async () => { vscode.env.openExternal(vscode.Uri.parse(reportIssueUrl)) }
        })
        registerCommand({
            command: 'aws.quickStart',
            callback: async () => { await showQuickStartWebview(context) }
        })

        const providers = [
            new LambdaTreeDataProvider(
                awsContext,
                awsContextTrees,
                regionProvider,
                resourceFetcher,
                getChannelLogger(toolkitOutputChannel),
                (relativeExtensionPath) => getExtensionAbsolutePath(context, relativeExtensionPath)
            )
        ]

        providers.forEach((p) => {
            p.initialize(context)
            context.subscriptions.push(vscode.window.registerTreeDataProvider(p.viewProviderId, p))
        })

        await ext.statusBar.updateContext(undefined)

        await initializeSamCli(
            new DefaultSettingsConfiguration(extensionSettingsPrefix),
            logFactory.getLogger()
        )

        await ExtensionDisposableFiles.initialize(context)

        vscode.languages.registerCompletionItemProvider(
            {
                language: 'json',
                scheme: 'file',
                pattern: '**/.aws/parameters.json'
            },
            new SamParameterCompletionItemProvider(),
            '"'
        )

        toastNewUser(context, logFactory.getLogger())

        await resumeCreateNewSamApp()
    } catch (error) {
        const channelLogger = getChannelLogger(toolkitOutputChannel)
        channelLogger.error(
            'AWS.channel.aws.toolkit.activation.error',
            'Error Activating AWS Toolkit',
            error as Error
        )
        throw error
    }
}

export async function deactivate() {
    await ext.telemetry.shutdown()
}

async function activateCodeLensProviders(
    configuration: SettingsConfiguration,
    toolkitOutputChannel: vscode.OutputChannel,
    telemetryService: TelemetryService,
): Promise<vscode.Disposable[]> {
    const disposables: vscode.Disposable[] = []
    const providerParams: CodeLensProviderParams = {
        configuration,
        outputChannel: toolkitOutputChannel,
        telemetryService,
    }

    tsLensProvider.initialize(providerParams)

    disposables.push(
        vscode.languages.registerCodeLensProvider(
            [
                {
                    language: 'javascript',
                    scheme: 'file',
                },
            ],
            tsLensProvider.makeTypescriptCodeLensProvider()
        )
    )

    await pyLensProvider.initialize(providerParams)
    disposables.push(vscode.languages.registerCodeLensProvider(
        pyLensProvider.PYTHON_ALLFILES,
        await pyLensProvider.makePythonCodeLensProvider(new DefaultSettingsConfiguration('python'))
    ))

    await csLensProvider.initialize(providerParams)
    disposables.push(vscode.languages.registerCodeLensProvider(
        csLensProvider.CSHARP_ALLFILES,
        await csLensProvider.makeCSharpCodeLensProvider()
    ))

    return disposables
}

/**
 * Performs SAM CLI relevant extension initialization
 */
async function initializeSamCli(
    settingsConfiguration: SettingsConfiguration,
    logger: logFactory.Logger,
): Promise<void> {
    SamCliContext.initialize({ settingsConfiguration, logger })

    registerCommand({
        command: 'aws.samcli.detect',
        callback: async () => await PromiseSharer.getExistingPromiseOrCreate(
            'samcli.detect',
            async () => await SamCliDetection.detectSamCli(true)
        )
    })

    await SamCliDetection.detectSamCli(false)
}

function getExtensionAbsolutePath(context: vscode.ExtensionContext, relativeExtensionPath: string): string {
    return context.asAbsolutePath(relativeExtensionPath)
}

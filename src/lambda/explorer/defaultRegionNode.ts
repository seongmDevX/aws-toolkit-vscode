/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { TreeItemCollapsibleState } from 'vscode'
import { RegionInfo } from '../../shared/regions/regionInfo'
import { AWSTreeNodeBase } from '../../shared/treeview/awsTreeNodeBase'
import { toMap, updateInPlace } from '../../shared/utilities/collectionUtils'
import { CloudFormationNode, DefaultCloudFormationNode } from './cloudFormationNodes'
import { RegionNode } from './regionNode'
import {
    DefaultStandaloneFunctionGroupNode,
    StandaloneFunctionGroupNode
} from './standaloneNodes'

// Collects the regions the user has declared they want to work with;
// on expansion each region lists the functions and CloudFormation Stacks
// the user has available in that region.
export class DefaultRegionNode extends AWSTreeNodeBase implements RegionNode {
    private info: RegionInfo
    private readonly cloudFormationNode: CloudFormationNode
    private readonly standaloneFunctionGroupNode: StandaloneFunctionGroupNode

    public get regionCode(): string {
        return this.info.regionCode
    }

    public get regionName(): string {
        return this.info.regionName
    }

    public constructor(
        info: RegionInfo,
        getExtensionAbsolutePath: (relativeExtensionPath: string) => string
    ) {
        super(info.regionName, TreeItemCollapsibleState.Expanded)
        this.contextValue = 'awsRegionNode'
        this.info = info
        this.update(info)

        this.cloudFormationNode = new DefaultCloudFormationNode(this, getExtensionAbsolutePath)
        this.standaloneFunctionGroupNode = new DefaultStandaloneFunctionGroupNode(this, getExtensionAbsolutePath)
    }

    public async getChildren(): Promise<AWSTreeNodeBase[]> {
        return [
            this.cloudFormationNode,
            this.standaloneFunctionGroupNode
        ]
    }

    public update(info: RegionInfo): void {
        this.info = info
        this.label = info.regionName
        this.tooltip = `${info.regionName} [${info.regionCode}]`
    }
}

export class RegionNodeCollection {
    private readonly regionNodes: Map<string, RegionNode>

    public constructor(
        private readonly getExtensionAbsolutePath: (relativeExtensionPath: string) => string
    ) {
        this.regionNodes = new Map<string, RegionNode>()
    }

    public async updateChildren(regionDefinitions: RegionInfo[]): Promise<void> {
        const regionMap = toMap(regionDefinitions, r => r.regionCode)

        updateInPlace(
            this.regionNodes,
            regionMap.keys(),
            key => this.regionNodes.get(key)!.update(regionMap.get(key)!),
            key => new DefaultRegionNode(
                regionMap.get(key)!,
                relativeExtensionPath => this.getExtensionAbsolutePath(relativeExtensionPath)
            )
        )
    }
}

// Copyright (c) 2022, Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ValidateError } from 'tsoa';
import { Connection } from '../sdk/gateway';

const DEFAULT_GAS_BUDGET = 2000;

interface AirdropClaimInfo {
    /**
     * Name of the source chain
     * @pattern ethereum
     */
    source_chain: string;
    /**
     * The Contract address for the original NFT on the source chain
     */
    source_contract_address: string;
    /**
     * The token id for the original NFT on the source chain
     */
    source_token_id: string;

    /**
     * The address of the claimer's wallet on the source chain
     */
    source_owner_address: string;
    /**
     * The recipient of the NFT on Sui
     */
    destination_sui_address: string;
}

/**
 *  The params for an Airdrop claim request.
 *
 *
 * @example {
 *   "wallet_message": "{\"domain\":{\"chainId\":1,\"name\":\"SuiDrop\",\"version\":\"1\"},\"message\":{\"source_chain\":\"ethereum\",\"source_contract_address\":\"0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D\",\"source_token_id\":\"8937\",\"source_owner_address\":\"0x09dbc4a902199bbe7f7ec29b3714731786f2e878\",\"destination_sui_address\":\"0xa5e6dbcf33730ace6ec8b400ff4788c1f150ff7e\"},\"primaryType\":\"ClaimRequest\",\"types\":{\"EIP712Domain\":[{\"name\":\"name\",\"type\":\"string\"},{\"name\":\"version\",\"type\":\"string\"},{\"name\":\"chainId\",\"type\":\"uint256\"}],\"ClaimRequest\":[{\"name\":\"source_chain\",\"type\":\"string\"},{\"name\":\"source_contract_address\",\"type\":\"string\"},{\"name\":\"source_token_id\",\"type\":\"string\"},{\"name\":\"source_owner_address\",\"type\":\"string\"},{\"name\":\"destination_sui_address\",\"type\":\"string\"}]}}",
 *   "signature": "abc"
 * }
 */
export interface AirdropClaimRequest {
    /**
     * An EIP-712 compliant message
     */
    wallet_message: string;
    /**
     * Digital signature of `message` signed by the private key of `source_owner_address`
     */
    signature: string;
}

/**
 *  The response for an Airdrop claim request.
 *
 *
 * @example {
 *  "source_chain": "ethereum",
 *  "source_contract_address": "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
 *  "source_token_id": "101",
 *  "sui_explorer_link": "http:127.0.0.1:8000/BC4CA0EdA7647A8a"
 * }
 */
export interface AirdropClaimResponse {
    /**
     * Name of the source chain
     * @pattern ethereum
     */
    source_chain: string;
    /**
     * The Contract address for the original NFT on the source chain
     */
    source_contract_address: string;
    /**
     * The token id for the original NFT on the source chain
     */
    source_token_id: string;
    /**
     * The Sui Explorer Link to the newly minted airdrop NFT
     */
    sui_explorer_link: string;
}

export class AirdropService {
    public async claim(
        claimMessage: AirdropClaimRequest
    ): Promise<AirdropClaimResponse> {
        const { wallet_message } = claimMessage;
        const data = JSON.parse(wallet_message);
        const claimInfo = this.parseClaimInfo(data);
        // TODO: validate signature and ownership
        const connection = new Connection(
            process.env.SUI_GATEWAY_ENDPOINT as string
        );
        await this.executeMoveCall(connection, claimInfo);
        return {
            source_chain: claimInfo.source_chain,
            source_contract_address: claimInfo.source_contract_address,
            source_token_id: claimInfo.source_token_id,
            sui_explorer_link:
                'https://djgd7fpxio1yh.cloudfront.net/objects/7bc832ec31709638cd8d9323e90edf332gff4389',
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parseClaimInfo(data: any): AirdropClaimInfo {
        if (isAirdropClaimInfo(data['message'])) {
            return data['message'] as AirdropClaimInfo;
        }
        throw new ValidateError(
            { messages: { message: 'Wrong format', value: data['message'] } },
            'Wrong format for wallet message'
        );
    }

    async executeMoveCall(
        connection: Connection,
        claimInfo: AirdropClaimInfo
    ): Promise<string> {
        const oracleAddress = process.env.ORACLE_ADDRESS as string;
        const [gasObjectId, oracleObjectId] = await this.getGasAndOracle(
            connection,
            oracleAddress
        );
        const {
            destination_sui_address,
            source_contract_address,
            source_token_id,
        } = claimInfo;

        // TODO: remove these hardcoded values in the next PR
        const name = 'BoredApeYachtClub';
        const tokenUri = 'ipfs://abc';

        const args = [
            oracleObjectId,
            destination_sui_address,
            source_contract_address,
            +source_token_id,
            name,
            tokenUri,
        ];

        const [packageObjectId, module] = this.getPackageAndModule();

        const request = {
            args,
            function: process.env.ORACLE_CONTRACT_ENTRY_FUNCTION as string,
            gasBudget: DEFAULT_GAS_BUDGET,
            gasObjectId,
            module,
            packageObjectId,
            sender: oracleAddress,
        };
        const result = await connection.callMoveFunction(request);
        const created = result.objectEffectsSummary.created_objects;
        if (created.length !== 1) {
            throw new Error(`Unexpected number of objects created: ${created}`);
        }
        console.info('Created object', created);
        return created[0].id;
    }

    async getGasAndOracle(
        connection: Connection,
        oracleAddress: string
    ): Promise<[string, string]> {
        const objects = await connection.bulkFetchObjects(oracleAddress);
        const gasCoin = objects.filter(
            (o) => o.objType === '0x2::Coin::Coin<0x2::GAS::GAS>'
        )[0].id;
        const oracle_object_identifier =
            this.getPackageAndModule().join('::') +
            '::' +
            (process.env.ORACLE_CONTRACT_ADMIN_IDENTIFIER as string);
        const oracle = objects.filter(
            (o) => o.objType === oracle_object_identifier
        );
        if (oracle.length !== 1) {
            throw new Error(`Unexpected number of oracle object: ${oracle}`);
        }

        return [
            this.formatObjectId(gasCoin),
            this.formatObjectId(oracle[0].id),
        ];
    }

    formatObjectId(id: string): string {
        return `0x${id}`;
    }

    getPackageAndModule(): [string, string] {
        const package_name = process.env.ORACLE_CONTRACT_PACKAGE || '0x2';
        const module_name =
            process.env.ORACLE_CONTRACT_MODULE || 'CrossChainAirdrop';
        return [package_name, module_name];
    }
}

/**
 * User Defined Type Guard for AirdropClaimInfo
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isAirdropClaimInfo(arg: any): arg is AirdropClaimInfo {
    return (
        arg.source_chain &&
        arg.source_contract_address &&
        arg.source_token_id &&
        arg.source_owner_address &&
        arg.destination_sui_address
    );
}
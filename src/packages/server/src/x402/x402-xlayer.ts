import type { NextFunction, Request, Response } from 'express';
import { ethers } from 'ethers';
import {
  getUsdtAddress,
  getXLayerCaip,
  getXLayerChainId,
  getXLayerNetwork,
  getXLayerRpcUrl,
  isX402DirectWalletMode,
} from '../config/xlayer.js';
import { okxPaymentsClient } from '../onchainos/okx-payments.js';

export interface X402RouteConfig {
  price: string;
  description?: string;
}

export function x402Middleware(
  routes: Record<string, X402RouteConfig>,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const routeKey = `${req.method.toUpperCase()} ${req.path}`;
    const config = routes[routeKey];

    if (!config) {
      next();
      return;
    }

    const paymentSignature = req.headers['payment-signature'];

    if (typeof paymentSignature !== 'string') {
      const requirement = {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: getXLayerCaip(),
            maxAmountRequired: config.price,
            resource: req.originalUrl,
            description: config.description || routeKey,
            payTo: process.env.TREASURY_ADDRESS || ethers.ZeroAddress,
            maxTimeoutSeconds: 60,
            asset: getUsdtAddress(),
          },
        ],
      };

      res.setHeader(
        'PAYMENT-REQUIRED',
        Buffer.from(JSON.stringify(requirement)).toString('base64'),
      );
      res.status(402).json(requirement);
      return;
    }

    try {
      const payload = JSON.parse(
        Buffer.from(paymentSignature, 'base64').toString('utf8'),
      ) as {
        txHash?: string;
        amount?: string;
        from?: string;
        x402Version?: number;
        scheme?: string;
        payload?: {
          signature?: string;
          authorization?: {
            from?: string;
            to?: string;
            value?: string;
            validAfter?: string;
            validBefore?: string;
            nonce?: string;
          };
        };
        accepts?: Array<Record<string, unknown>>;
        paymentRequirements?: Record<string, unknown>;
        paymentPayload?: Record<string, unknown>;
      };

      if (shouldUseOfficialProofMiddleware()) {
        const paymentRequirements = normalizePaymentRequirements(config, req, payload);
        const paymentPayload = normalizePaymentPayload(payload, paymentRequirements);
        const paymentPayloadData =
          paymentPayload.payload && typeof paymentPayload.payload === 'object'
            ? paymentPayload.payload as {
                authorization?: {
                  from?: string;
                  value?: string;
                };
              }
            : undefined;
        const body = {
          x402Version: Number(paymentPayload.x402Version ?? payload.x402Version ?? 2),
          chainIndex: String(getXLayerChainId()),
          paymentPayload,
          paymentRequirements,
        };

        const verify = await okxPaymentsClient.verify(body);
        const verifyRecord = normalizeOkxRecord(verify.payload);
        if (!verifyRecord.isValid) {
          res.status(402).json({
            error: 'Invalid payment proof',
            invalidReason: verifyRecord.invalidReason ?? 'invalid_payment',
          });
          return;
        }

        const settle = await okxPaymentsClient.settle(body);
        const settleRecord = normalizeOkxRecord(settle.payload);
        if (!settleRecord.success || typeof settleRecord.txHash !== 'string') {
          res.status(402).json({
            error: 'Payment settlement failed',
            details: settleRecord.errorReason ?? settleRecord.errorMsg ?? 'missing_tx_hash',
          });
          return;
        }

        (req as Request & {
          x402Payment?: {
            txHash?: string;
            amount?: string;
            from?: string;
            onchainStatus?: string;
            verifyEndpoint?: string;
            settleEndpoint?: string;
          };
        }).x402Payment = {
          txHash: settleRecord.txHash,
          amount: String(
            paymentPayloadData?.authorization?.value ??
              paymentRequirements.maxAmountRequired ??
              config.price,
          ),
          from:
            typeof verifyRecord.payer === 'string'
              ? verifyRecord.payer
              : paymentPayloadData?.authorization?.from,
          onchainStatus: 'settled',
          verifyEndpoint: verify.endpoint,
          settleEndpoint: settle.endpoint,
        };

        res.setHeader(
          'PAYMENT-RESPONSE',
          Buffer.from(
            JSON.stringify({
              success: true,
              network: getXLayerCaip(),
              txHash: settleRecord.txHash,
              payer:
                typeof verifyRecord.payer === 'string'
                  ? verifyRecord.payer
                  : paymentPayloadData?.authorization?.from ?? null,
            }),
          ).toString('base64'),
        );
        next();
        return;
      }

      if (payload.txHash && process.env.X_LAYER_RPC) {
        const provider = new ethers.JsonRpcProvider(getXLayerRpcUrl());
        const transaction = await provider.getTransaction(payload.txHash);
        if (!transaction) {
          res.status(402).json({ error: 'Transaction not found' });
          return;
        }
      }

      (req as Request & {
        x402Payment?: { txHash?: string; amount?: string; from?: string };
      }).x402Payment = payload;

      res.setHeader(
        'PAYMENT-RESPONSE',
        Buffer.from(
          JSON.stringify({
            success: true,
            network: getXLayerCaip(),
            txHash: payload.txHash ?? null,
          }),
        ).toString('base64'),
      );
      next();
    } catch (error) {
      res.status(402).json({ error: 'Invalid payment signature', details: String(error) });
    }
  };
}

function shouldUseOfficialProofMiddleware(): boolean {
  return (
    getXLayerNetwork() === 'mainnet' &&
    isX402DirectWalletMode() &&
    okxPaymentsClient.isConfigured()
  );
}

function normalizePaymentRequirements(
  config: X402RouteConfig,
  req: Request,
  payload: {
    paymentRequirements?: Record<string, unknown>;
    accepts?: Array<Record<string, unknown>>;
  },
): Record<string, unknown> {
  if (payload.paymentRequirements && typeof payload.paymentRequirements === 'object') {
    return payload.paymentRequirements;
  }

  const accepted = Array.isArray(payload.accepts) ? payload.accepts[0] : null;
  return {
    scheme:
      (accepted && typeof accepted.scheme === 'string' ? accepted.scheme : null) ?? 'exact',
    chainIndex: String(getXLayerChainId()),
    resource: req.originalUrl,
    description:
      (accepted && typeof accepted.description === 'string' ? accepted.description : null) ??
      config.description ??
      `${req.method.toUpperCase()} ${req.path}`,
    maxAmountRequired:
      (accepted &&
      (typeof accepted.maxAmountRequired === 'string' || typeof accepted.maxAmountRequired === 'number')
        ? String(accepted.maxAmountRequired)
        : null) ?? config.price,
    payTo:
      (accepted && typeof accepted.payTo === 'string' ? accepted.payTo : null) ??
      process.env.TREASURY_ADDRESS ??
      ethers.ZeroAddress,
    maxTimeoutSeconds:
      accepted && typeof accepted.maxTimeoutSeconds === 'number'
        ? accepted.maxTimeoutSeconds
        : 60,
    asset:
      (accepted && typeof accepted.asset === 'string' ? accepted.asset : null) ??
      getUsdtAddress(),
  };
}

function normalizePaymentPayload(
  payload: {
    x402Version?: number;
    scheme?: string;
    payload?: Record<string, unknown>;
    paymentPayload?: Record<string, unknown>;
  },
  paymentRequirements: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.paymentPayload && typeof payload.paymentPayload === 'object') {
    return payload.paymentPayload;
  }

  return {
    x402Version: Number(payload.x402Version ?? 2),
    scheme:
      typeof payload.scheme === 'string'
        ? payload.scheme
        : String(paymentRequirements.scheme ?? 'exact'),
    chainIndex: String(getXLayerChainId()),
    payload: payload.payload ?? {},
  };
}

function normalizeOkxRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const envelope = payload as Record<string, unknown>;
  if (Array.isArray(envelope.data) && envelope.data[0] && typeof envelope.data[0] === 'object') {
    return envelope.data[0] as Record<string, unknown>;
  }
  if (envelope.data && typeof envelope.data === 'object') {
    return envelope.data as Record<string, unknown>;
  }

  return envelope;
}

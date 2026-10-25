import { useSyncExternalStore } from 'react';
import { getMeshStatus, subscribeMeshStatus } from '../../services/airplane/transport';

/** Where this device's posts can travel right now. */
export type RelayState = 'mesh' | 'online' | 'offline';

export interface MeshStatusState {
    /** Established BLE connections (linked mesh neighbours). */
    peersNearby: number;
    /** 'mesh' = mesh radio only, 'online' = internet up (World feed visible), 'offline' = neither. */
    relayState: RelayState;
}

/**
 * Mesh + relay status for the MeshStatus pill, wired to the real transport.
 *
 * Previously a hardcoded stub (peersNearby always 0, relayState always
 * 'mesh') — the pill read "0 nearby mesh only" even with mesh peers
 * connected, and mislabelled internet-synced operation as mesh-only.
 * Now: peersNearby counts established BLE connections (polled every 2s by
 * the transport's subscription; the port emits no connect/disconnect
 * events, so polling is the honest mechanism), and relayState reflects
 * whether Nostr is online. Snapshot identity is stable unless a value
 * changes, as useSyncExternalStore requires.
 */
export function useMeshStatus(): MeshStatusState {
    return useSyncExternalStore(subscribeMeshStatus, getMeshStatus);
}

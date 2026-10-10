import { useMemo } from 'react';

/** Where this device's posts can travel right now. */
export type RelayState = 'mesh' | 'online' | 'offline';

export interface MeshStatusState {
    /** Peers seen on the BLE mesh. Stays 0 until the real transport is wired. */
    peersNearby: number;
    /** 'mesh' = mesh radio only, 'online' = internet up (World feed visible), 'offline' = radio down. */
    relayState: RelayState;
}

/**
 * Mesh + relay status for the MeshStatus pill.
 *
 * STUB (P3): returns peersNearby 0 and assumes mesh radio until the real
 * transport lands. packages/mesh-sim exists for tests; the P3 BLE transport
 * (MESH-1) will drive these values for real. No fake live numbers.
 */
export function useMeshStatus(): MeshStatusState {
    return useMemo(() => ({ peersNearby: 0, relayState: 'mesh' as RelayState }), []);
}

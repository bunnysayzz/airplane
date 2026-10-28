// SPDX-License-Identifier: Apache-2.0
// Feed scope resolution tests: granted -> own cell + 8 neighbours;
// denied/undetermined -> []; resolution failure -> null (keep previous)
// and the failure is logged to Sentry.

import { neighbors } from '@airplane/protocol';
import { __resetFeedCellsThrottleForTests, resolveFeedCells } from './feedCells';
import { getLocationCell, getLocationPermissionStatus } from './location';
import { captureError } from '../../src/sentry';

jest.mock('./location', () => ({
  getLocationCell: jest.fn(),
  getLocationPermissionStatus: jest.fn(),
}));

jest.mock('../../src/sentry', () => ({
  captureError: jest.fn(),
}));

const mockStatus = getLocationPermissionStatus as jest.MockedFunction<
  typeof getLocationPermissionStatus
>;
const mockCell = getLocationCell as jest.MockedFunction<typeof getLocationCell>;
const mockCapture = captureError as jest.MockedFunction<typeof captureError>;

beforeEach(() => {
  jest.clearAllMocks();
  __resetFeedCellsThrottleForTests();
});

describe('resolveFeedCells', () => {
  test('granted permission resolves the cell + 8 neighbours', async () => {
    mockStatus.mockResolvedValue('granted');
    mockCell.mockResolvedValue('tdr1v');
    await expect(resolveFeedCells()).resolves.toEqual(neighbors('tdr1v'));
    expect(mockCell).toHaveBeenCalledTimes(1);
  });

  test('denied permission returns [] without touching GPS', async () => {
    mockStatus.mockResolvedValue('denied');
    await expect(resolveFeedCells()).resolves.toEqual([]);
    expect(mockCell).not.toHaveBeenCalled();
  });

  test('undetermined permission returns [] without touching GPS', async () => {
    mockStatus.mockResolvedValue('undetermined');
    await expect(resolveFeedCells()).resolves.toEqual([]);
    expect(mockCell).not.toHaveBeenCalled();
  });

  test('a permission-status failure returns null and logs to Sentry', async () => {
    mockStatus.mockRejectedValue(new Error('status boom'));
    await expect(resolveFeedCells()).resolves.toBeNull();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  test('a cell-resolution failure returns null and logs to Sentry', async () => {
    mockStatus.mockResolvedValue('granted');
    mockCell.mockRejectedValue(new Error('gps boom'));
    await expect(resolveFeedCells()).resolves.toBeNull();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  test('repeated scope failures within a minute report to Sentry only once', async () => {
    mockStatus.mockResolvedValue('granted');
    mockCell.mockRejectedValue(new Error('gps boom'));
    await expect(resolveFeedCells()).resolves.toBeNull();
    await expect(resolveFeedCells()).resolves.toBeNull();
    await expect(resolveFeedCells()).resolves.toBeNull();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  test('a permission granted after a denial is picked up on re-resolve (focus refresh)', async () => {
    mockStatus.mockResolvedValueOnce('denied');
    mockStatus.mockResolvedValueOnce('granted');
    mockCell.mockResolvedValue('tdr1v');
    await expect(resolveFeedCells()).resolves.toEqual([]);
    await expect(resolveFeedCells()).resolves.toEqual(neighbors('tdr1v'));
  });
});

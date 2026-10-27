// Jest mock for @react-native-community/netinfo (native module).
export default {
  fetch: jest.fn().mockResolvedValue({
    isConnected: false,
    isInternetReachable: false,
  }),
  addEventListener: jest.fn().mockReturnValue(jest.fn()),
};

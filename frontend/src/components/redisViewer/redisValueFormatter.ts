import {
    toHexDisplay,
    decodeRedisUtf8Value,
    formatRedisStringValue,
} from '../../utils/redisValueDisplay';
import type { RedisViewerStateApi } from './useRedisViewerState';

export interface CreateRedisValueFormatterInput {
    viewMode: RedisViewerStateApi['viewMode'];
}

export const createRedisValueFormatter = ({ viewMode }: CreateRedisValueFormatterInput) => {
    const processValueForCurrentView = (value: string) => {
        if (viewMode === 'hex') {
            return { displayValue: toHexDisplay(value), isBinary: true, isJson: false, encoding: 'HEX' };
        }

        if (viewMode === 'text') {
            return { displayValue: value, isBinary: false, isJson: false, encoding: 'Text' };
        }

        if (viewMode === 'utf8') {
            return { displayValue: decodeRedisUtf8Value(value), isBinary: false, isJson: false, encoding: 'UTF-8' };
        }

        return formatRedisStringValue(value);
    };
    return { processValueForCurrentView };
};

export type RedisValueFormatterApi = ReturnType<typeof createRedisValueFormatter>;

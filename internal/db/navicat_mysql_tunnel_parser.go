package db

import (
	"database/sql/driver"
	"encoding/binary"
	"fmt"
	"io"
	"math"
)

func (p *navicatMySQLTunnelParser) parseCommonHeader() (uint16, error) {
	magic, err := p.readUint32()
	if err != nil {
		return 0, fmt.Errorf("Navicat HTTP 隧道响应头不完整：%w", err)
	}
	if magic != navicatMySQLTunnelMagic {
		return 0, fmt.Errorf("响应不是 Navicat HTTP 隧道协议（开头：%s）", navicatMySQLTunnelResponseSnippet(p.body))
	}
	version, err := p.readUint16()
	if err != nil {
		return 0, fmt.Errorf("Navicat HTTP 隧道响应缺少脚本版本：%w", err)
	}
	errno, err := p.readUint32()
	if err != nil {
		return 0, fmt.Errorf("Navicat HTTP 隧道响应缺少错误码：%w", err)
	}
	if _, err := p.read(6); err != nil {
		return 0, fmt.Errorf("Navicat HTTP 隧道响应头不完整：%w", err)
	}
	if errno > 0 {
		message, blockErr := p.parseBlock()
		if blockErr != nil {
			return version, fmt.Errorf("Navicat HTTP 隧道错误 %d，且错误信息无法解析：%w", errno, blockErr)
		}
		return version, &navicatMySQLTunnelProtocolError{code: errno, message: string(message)}
	}
	return version, nil
}

func (p *navicatMySQLTunnelParser) parseResult() (*navicatMySQLTunnelResult, error) {
	errno, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果头不完整：%w", err)
	}
	affected, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果缺少影响行数：%w", err)
	}
	insertID, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果缺少自增 ID：%w", err)
	}
	fieldCount, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果缺少字段数：%w", err)
	}
	rowCount, err := p.readUint32()
	if err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果缺少行数：%w", err)
	}
	if _, err := p.read(12); err != nil {
		return nil, fmt.Errorf("Navicat HTTP 隧道结果头不完整：%w", err)
	}
	if errno > 0 {
		message, blockErr := p.parseBlock()
		if blockErr != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道查询错误 %d，且错误信息无法解析：%w", errno, blockErr)
		}
		return nil, &navicatMySQLTunnelProtocolError{code: errno, message: string(message)}
	}
	if fieldCount > maxNavicatMySQLTunnelFields {
		return nil, fmt.Errorf("Navicat HTTP 隧道字段数异常：%d", fieldCount)
	}
	if rowCount > maxNavicatMySQLTunnelRows {
		return nil, fmt.Errorf("Navicat HTTP 隧道行数异常：%d", rowCount)
	}
	cellCount := uint64(fieldCount) * uint64(rowCount)
	if cellCount > maxNavicatMySQLTunnelCells {
		return nil, fmt.Errorf("Navicat HTTP 隧道解码分配异常：字段数 %d x 行数 %d = %d 个单元格", fieldCount, rowCount, cellCount)
	}

	result := &navicatMySQLTunnelResult{
		affectedRows: navicatMySQLTunnelUint32ToInt64(affected),
		insertID:     navicatMySQLTunnelUint32ToInt64(insertID),
	}
	if fieldCount == 0 {
		info, err := p.parseBlock()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道执行信息不完整：%w", err)
		}
		result.info = string(info)
		return result, nil
	}

	if err := p.reserveDecodedAllocation(uint64(fieldCount) * 96); err != nil {
		return nil, err
	}
	result.fields = make([]navicatMySQLTunnelField, fieldCount)
	for index := range result.fields {
		name, err := p.parseBlock()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 名称不完整：%w", index+1, err)
		}
		table, err := p.parseBlock()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 表名不完整：%w", index+1, err)
		}
		if err := p.reserveDecodedAllocation(uint64(len(name) + len(table))); err != nil {
			return nil, err
		}
		typeID, err := p.readUint32()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 类型不完整：%w", index+1, err)
		}
		flags, err := p.readUint32()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 标志不完整：%w", index+1, err)
		}
		length, err := p.readUint32()
		if err != nil {
			return nil, fmt.Errorf("Navicat HTTP 隧道字段 %d 长度不完整：%w", index+1, err)
		}
		result.fields[index] = navicatMySQLTunnelField{
			name: string(name), table: string(table), typeID: typeID, flags: flags, length: length,
			databaseTy: navicatMySQLDatabaseTypeName(typeID),
		}
	}

	if cellCount > uint64(len(p.body)-p.offset) {
		return nil, fmt.Errorf("Navicat HTTP 隧道行数据不完整：%d 个单元格至少需要 %d 字节，仅剩 %d 字节", cellCount, cellCount, len(p.body)-p.offset)
	}
	// 64-bit Go uses 24 bytes per slice header and 16 bytes per interface slot.
	// The estimate is deliberately conservative and guards allocation before make.
	allocationEstimate := uint64(rowCount)*24 + cellCount*16
	if err := p.reserveDecodedAllocation(allocationEstimate); err != nil {
		return nil, err
	}
	result.rows = make([][]driver.Value, rowCount)
	for rowIndex := range result.rows {
		row := make([]driver.Value, fieldCount)
		for columnIndex := range row {
			first, err := p.readByte()
			if err != nil {
				return nil, fmt.Errorf("Navicat HTTP 隧道第 %d 行第 %d 列不完整：%w", rowIndex+1, columnIndex+1, err)
			}
			if first == 0xff {
				row[columnIndex] = nil
				continue
			}
			value, err := p.parseBlockWithFirstByte(first)
			if err != nil {
				return nil, fmt.Errorf("Navicat HTTP 隧道第 %d 行第 %d 列不完整：%w", rowIndex+1, columnIndex+1, err)
			}
			row[columnIndex] = value
		}
		result.rows[rowIndex] = row
	}
	return result, nil
}

func navicatMySQLTunnelUint32ToInt64(value uint32) int64 {
	if value == math.MaxUint32 {
		return 0
	}
	return int64(value)
}

func (p *navicatMySQLTunnelParser) parseBlock() ([]byte, error) {
	first, err := p.readByte()
	if err != nil {
		return nil, err
	}
	return p.parseBlockWithFirstByte(first)
}

func (p *navicatMySQLTunnelParser) parseBlockWithFirstByte(first byte) ([]byte, error) {
	length := uint32(first)
	if first == 0xfe {
		var err error
		length, err = p.readUint32()
		if err != nil {
			return nil, err
		}
	}
	if uint64(length) > uint64(len(p.body)-p.offset) {
		return nil, io.ErrUnexpectedEOF
	}
	if length == 0 {
		return []byte{}, nil
	}
	value, err := p.read(int(length))
	if err != nil {
		return nil, err
	}
	// Values remain immutable and retain the response backing array. Avoiding a
	// second copy keeps decoded memory bounded by the wire-body limit.
	return value, nil
}

func (p *navicatMySQLTunnelParser) reserveDecodedAllocation(size uint64) error {
	if size > maxNavicatMySQLTunnelDecodedAllocBytes-p.decodedAllocationSize {
		return fmt.Errorf("Navicat HTTP 隧道解码分配超过 %d MiB 限制", maxNavicatMySQLTunnelDecodedAllocBytes>>20)
	}
	p.decodedAllocationSize += size
	return nil
}

func (p *navicatMySQLTunnelParser) readUint16() (uint16, error) {
	value, err := p.read(2)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint16(value), nil
}

func (p *navicatMySQLTunnelParser) readUint32() (uint32, error) {
	value, err := p.read(4)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(value), nil
}

func (p *navicatMySQLTunnelParser) readByte() (byte, error) {
	value, err := p.read(1)
	if err != nil {
		return 0, err
	}
	return value[0], nil
}

func (p *navicatMySQLTunnelParser) read(length int) ([]byte, error) {
	if length < 0 || p.offset > len(p.body)-length {
		return nil, io.ErrUnexpectedEOF
	}
	value := p.body[p.offset : p.offset+length]
	p.offset += length
	return value, nil
}

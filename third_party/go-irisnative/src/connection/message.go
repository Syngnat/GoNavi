package connection

import (
	"fmt"
	"io"
	"net"
	"time"

	"github.com/caretdev/go-irisnative/src/list"
)

type Message struct {
	header MessageHeader
	data   []byte
	offset uint
}

func NewMessage(messageType MessageType) Message {
	return Message{
		NewMessageHeader(messageType),
		[]byte{},
		0,
	}
}

// ReadMessage 同步读取一条消息，永远不会超时，对端不响应就永久阻塞。
// 驱动上层（driver.conn）目前没有任何路径在调用前设置 SetReadDeadline，
// 这会让 INFORMATION_SCHEMA、%SYS 命名空间查询在受限账号上挂死，
// 表现为上层「转圈」（GoNavi issue #1430/#1427）。
// 保留它给握手等必须阻塞的场景；查询路径请改用 ReadMessageWithTimeout。
func ReadMessage(conn *net.TCPConn) (msg Message, err error) {
	buffer := make([]byte, 14)

	_, err = conn.Read(buffer)
	if err != nil {
		return
	}

	var header [14]byte
	copy(header[:], buffer[:14])
	var msgHeader = MessageHeader{header}

	length := msgHeader.GetLength()
	data := make([]byte, length)
	var offset int = 0
	var size int
	for {
		size, err = conn.Read(data[offset:])
		if err != nil {
			if err != io.EOF {
				return
			}
			break
		}
		offset += size
		if offset >= int(length) {
			break
		}
	}

	msg = Message{msgHeader, data, 0}

	return
}

// ReadMessageWithTimeout 在每次 Read 之前设置 ReadDeadline，
// 到期或取消立即返回错误，避免受限账号在 %SYS 等系统视图上永久阻塞。
// timeout 为 0 表示不设置超时（保持原行为）；调用方需自己保证不长期使用 0。
func ReadMessageWithTimeout(conn *net.TCPConn, timeout time.Duration) (msg Message, err error) {
	if timeout > 0 {
		if err = conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			return
		}
		// 读完后清掉，避免影响同一连接的下一次操作。
		defer func() { _ = conn.SetReadDeadline(time.Time{}) }()
	}
	return ReadMessage(conn)
}

func (m *Message) AddRaw(value interface{}) {
	switch v := value.(type) {
	case uint16:
		m.data = append(m.data, byte(v&0xff))
		m.data = append(m.data, byte(v>>8&0xff))
		m.offset += 2
	case []byte:
		m.data = append(m.data, v...)
		m.offset += uint(len(v))
	}
}

func (m *Message) GetRaw(value interface{}) error {
	switch v := value.(type) {
	case *uint16:
		*v = uint16(m.data[m.offset]) | (uint16(m.data[m.offset+1]) << 8)
		m.offset += 2
	case *bool:
		*v = (uint16(m.data[m.offset]) | (uint16(m.data[m.offset+1]) << 8)) == 1
		m.offset += 2
	case *[]byte:
		*v = m.data[m.offset:]
		m.offset = uint(len(m.data))
	default:
		return fmt.Errorf("unknown type: %T", v)
	}
	return nil
}

func (m *Message) Set(value interface{}) error {
	listItem := list.NewListItem(value)
	m.AddRaw(listItem.Dump())
	return nil
}

func (m *Message) SetSQLText(sqlText string) error {
	len := len(sqlText)
	if len == 0 {
		m.Set(sqlText)
		return nil
	}
	const chunksize = 31904
	chunks := len / chunksize
	if len%chunksize != 0 {
		chunks += 1
	}
	m.Set(chunks)
	for i := 0; i < chunks; i++ {
		begin := i * chunksize
		end := (i + 1) * chunksize
		if end > len {
			end = len
		}
		m.Set(sqlText[begin:end])
	}
	return nil
}

func (m *Message) GetStatus() uint16 {
	return m.header.GetStatus()
}

// exhausted 报告消息是否已读到末尾。旧版服务端会省略若干尾部字段，
// 调用方据此判断还有没有字段可读。
func (m *Message) exhausted() bool {
	return int(m.offset) >= len(m.data)
}

func (m *Message) Get(value interface{}) error {
	listItem := list.GetListItem(m.data, &m.offset)
	listItem.Get(value)
	return nil
}

type AnyType struct {
	listItem list.ListItem
}

func (v *AnyType) Int() int {
	var value int
	v.listItem.Get(&value)
	return value
}

func (m *Message) GetAny() AnyType {
	listItem := list.GetListItem(m.data, &m.offset)
	return AnyType{listItem}
}

func (m *Message) Dump(count uint32) []byte {
	m.header.SetCount(count)
	m.header.SetLength(uint32(len(m.data)))

	return append(m.header.header[:], m.data...)
}

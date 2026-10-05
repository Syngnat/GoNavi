package runharness

import (
	"fmt"
	"strings"
)

// What the person attached to a message (a document, text recognized in a
// screenshot, an image) is stored with the message so the chat can show it, but
// it is only the model that has to *read* it. The context builder therefore
// projects the attachments of each user message into what the provider is sent:
// documents and recognized text become part of the message text, and images go
// along as images when the provider can take them. The stored transcript is
// never changed.
//
// Everything is bounded. A document is cut to a fixed size, and what one message
// carries may take only part of the prompt budget, so a large file cannot crowd
// out the conversation or fail the run.

// OCRTextMediaType marks an attachment holding text the desktop recognized in an
// image. It is sent to the model like a document, but described as recognized
// text, which may contain mistakes.
const OCRTextMediaType = "application/vnd.gonavi.ocr+text"

const (
	// maxDocumentBytes bounds the text of one attachment.
	maxDocumentBytes = 48 << 10
	// A message's attachments may take at most this share of the prompt budget.
	attachmentBudgetNumerator   = 1
	attachmentBudgetDenominator = 2
	// minUsefulDocumentBytes is the least of a document worth sending; below it
	// the document is left out and the model is told so.
	minUsefulDocumentBytes = 200
	// imageCostBytes is what one image counts for in the budget. Its size on the
	// wire (base64) says nothing about what the provider charges for it.
	imageCostBytes = 1500

	documentTruncationMarker = "\n[... truncated to fit the model's context window ...]"
)

type documentPart struct {
	name       string
	mediaType  string
	text       string
	recognized bool // text recognized from an image
}

// projectAttachments returns the messages as the provider should see them. Only
// user messages carry attachments. Images travel with the newest user message
// only (an older screenshot is not sent again with every turn); when images cannot
// be sent at all, the model is told an image was attached instead of silently
// never hearing of it.
func projectAttachments(messages []Message, promptBudget int, omitImages bool) []Message {
	projected := append([]Message(nil), messages...)
	newest := newestUserIndex(projected)
	for i := range projected {
		message := &projected[i]
		if message.Role != "user" || len(message.Attachments) == 0 {
			continue
		}
		documents, images := splitAttachments(message.Attachments)
		var notes []string
		if len(images) > 0 {
			switch {
			case omitImages:
				notes = append(notes, unreadableImageNotes(images, documents)...)
			case i == newest:
				message.Images = append(append([]string(nil), message.Images...), imageData(images)...)
			default:
				notes = append(notes, fmt.Sprintf("[%d image(s) attached earlier in the conversation are not sent again.]", len(images)))
			}
		}
		block := renderDocuments(documents, notes, attachmentBudget(promptBudget))
		if block != "" {
			message.Content = joinNonEmpty(message.Content, block)
		}
	}
	return projected
}

func newestUserIndex(messages []Message) int {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			return i
		}
	}
	return -1
}

func attachmentBudget(promptBudget int) int {
	if promptBudget <= 0 {
		return 0 // unlimited
	}
	return promptBudget * attachmentBudgetNumerator / attachmentBudgetDenominator
}

// splitAttachments separates what is read as text from what is an image. The
// context chips (selections, quotes, table schemas) are not attachments to the
// model: they reach it through the workspace.
func splitAttachments(attachments []Attachment) (documents []documentPart, images []Attachment) {
	for _, attachment := range attachments {
		switch {
		case attachment.MediaType == ContextChipMediaType:
		case strings.HasPrefix(attachment.Data, "data:image/"):
			images = append(images, attachment)
		case attachment.MediaType == OCRTextMediaType:
			documents = append(documents, documentPart{name: attachment.Name, text: attachment.Data, recognized: true})
		default:
			documents = append(documents, documentPart{name: attachment.Name, mediaType: attachment.MediaType, text: attachment.Data})
		}
	}
	return documents, images
}

func imageData(images []Attachment) []string {
	data := make([]string, 0, len(images))
	for _, image := range images {
		data = append(data, image.Data)
	}
	return data
}

// unreadableImageNotes names the images the model cannot see, except those whose
// text was recognized (that text is attached under the same name).
func unreadableImageNotes(images []Attachment, documents []documentPart) []string {
	recognized := map[string]bool{}
	for _, document := range documents {
		if document.recognized {
			recognized[document.name] = true
		}
	}
	var notes []string
	for _, image := range images {
		if !recognized[image.Name] {
			notes = append(notes, fmt.Sprintf("[Image %q is attached, but this model cannot see images and no text was recognized in it.]", image.Name))
		}
	}
	return notes
}

// renderDocuments writes the attached documents into one block, keeping within
// budget bytes in all (0 means no limit) and telling the model what was cut or
// left out.
func renderDocuments(documents []documentPart, notes []string, budget int) string {
	if len(documents) == 0 && len(notes) == 0 {
		return ""
	}
	var out strings.Builder
	out.WriteString("<attached_files>\n")
	remaining := budget
	omitted := 0
	for index, document := range documents {
		text := strings.TrimSpace(document.text)
		if text == "" {
			out.WriteString(fmt.Sprintf("### %s\n[No readable text was extracted from this file.]\n\n", describeDocument(index, document)))
			continue
		}
		limit := maxDocumentBytes
		if budget > 0 {
			if remaining < minUsefulDocumentBytes {
				omitted++
				continue
			}
			limit = min(limit, remaining)
		}
		if len(text) > limit {
			text = truncateUTF8(text, limit-len(documentTruncationMarker)) + documentTruncationMarker
		}
		remaining -= len(text)
		fence := fenceFor(text)
		out.WriteString(fmt.Sprintf("### %s\n%s\n%s\n%s\n\n", describeDocument(index, document), fence, text, fence))
	}
	if omitted > 0 {
		out.WriteString(fmt.Sprintf("[%d more attachment(s) were left out: there is no room for them in the context window.]\n\n", omitted))
	}
	for _, note := range notes {
		out.WriteString(note + "\n")
	}
	out.WriteString("</attached_files>")
	return out.String()
}

func describeDocument(index int, document documentPart) string {
	name := strings.TrimSpace(document.name)
	if name == "" {
		name = "attachment"
	}
	if document.recognized {
		return fmt.Sprintf("Text recognized from the image %q (OCR, may contain mistakes)", name)
	}
	if document.mediaType != "" {
		return fmt.Sprintf("Attached file %d: %s (%s)", index+1, name, document.mediaType)
	}
	return fmt.Sprintf("Attached file %d: %s", index+1, name)
}

// fenceFor returns a code fence longer than any run of backticks in text, so the
// document cannot close it early.
func fenceFor(text string) string {
	longest, run := 0, 0
	for _, r := range text {
		if r == '`' {
			run++
			longest = max(longest, run)
		} else {
			run = 0
		}
	}
	return strings.Repeat("`", max(3, longest+1))
}

func joinNonEmpty(first, second string) string {
	if strings.TrimSpace(first) == "" {
		return second
	}
	return first + "\n\n" + second
}

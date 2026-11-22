# starsieve

starsieve turns things a person saved on GitHub and X into a categorized collection they can browse privately and publish publicly.

## Collection

**Item**:
One saved thing from one Source: a starred GitHub repository, or an X post the owner liked or bookmarked.
_Avoid_: entry, record, bookmark (as a general term)

**Source**:
The service an Item comes from: GitHub or X.
_Avoid_: platform, provider

**Signal**:
The owner's action that made something an Item: star, like or bookmark. One X post can carry both like and bookmark.
_Avoid_: save type, origin

**Skipped Item**:
An X post the owner liked or bookmarked that is not technical. Only its id is kept, so it is never judged again; it is never shown or published. When the owner restores one, it is re-collected and can never be skipped again.
_Avoid_: filtered post, ignored item

**Backfill**:
A one-time long read down an X list from the top, saved as it goes, until the list ends or stops loading. X lists are not ordered by post time. Its reach is recorded, and completeness stays unknown.
_Avoid_: import, history sync

## Classification

**Category**:
The single main group an Item belongs to, by what it is for or which field it belongs to (for example AI 视频与动画); what kind of thing the Item is goes in its first Tag. Categories that contain GitHub Items mirror into GitHub Lists.
_Avoid_: folder, list (except for the GitHub feature), topic

**Category Table**:
The fixed set of Categories shared by both Sources. The agent proposes it once; afterwards it only grows when enough Items do not fit.
_Avoid_: taxonomy, schema

**Tag**:
A free label on an Item for filtering, such as a language or subject. An Item has several.
_Avoid_: label, keyword

**Classification**:
The Category, Tags, Summary and Visibility the agent or the owner gave one Item.
_Avoid_: annotation, result

**Batch**:
A group of Items handed to the agent for Classification in one go.
_Avoid_: chunk, job

**Needs Review**:
A flag on a Classification the agent was not sure about.
_Avoid_: low confidence, pending

**Locked**:
A Classification the owner changed by hand; the agent never overwrites it.
_Avoid_: pinned, manual override

**Classifier**:
Whichever agent CLI produces Classifications, run with no tools. starsieve itself never calls a model.
_Avoid_: AI, LLM, model

## Publishing

**Visibility**:
Whether an Item may appear publicly: public or private. Unknown means private.
_Avoid_: privacy, sharing

**Public Projection**:
The subset of Items and fields that may be published: public Items only; X Items reduced to link, author handle, post time, Category, Summary and Tags, never the post text.
_Avoid_: export, public copy

**Private Store**:
The private repository that holds every Item, its raw data and its Classification.
_Avoid_: database, backend

**Public Collection**:
The public repository and site built from the Public Projection.
_Avoid_: showcase, gallery

**Heartbeat**:
The times of the last attempted run and the last successful run, updated even when nothing was new.
_Avoid_: status, last sync

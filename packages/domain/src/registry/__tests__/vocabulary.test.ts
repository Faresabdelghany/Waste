// The Registry vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts): non-empty lists of kebab-case tokens, no
// value twice, and every list named in `REGISTRY_VOCABULARIES`, which is what
// lets the API, a form or another test walk them all.
import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Registry", vocabulary, vocabulary.REGISTRY_VOCABULARIES, 20)

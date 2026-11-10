// The scale house's vocabulary, held to the shape every vocabulary module keeps (src/__tests__/vocabulary.ts).
import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("scale-house", vocabulary, vocabulary.SCALE_HOUSE_VOCABULARIES)
